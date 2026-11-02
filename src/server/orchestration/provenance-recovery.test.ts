import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { jobPayloadSchema, type EvaluationResult } from "@/lib/contracts";
import { FakeCodexAdapter } from "@/server/codex/fake-adapter";
import type {
  AdapterResponse,
  GenerateImagesInput,
  GenerateImagesResult,
} from "@/server/codex/types";

const previousEnvironment = {
  DATABASE_URL: process.env.DATABASE_URL,
  IEVCS_DATA_ROOT: process.env.IEVCS_DATA_ROOT,
};

let temporaryRoot: string;
let db: PrismaClient;
let projectPaths: (typeof import("@/server/paths"))["projectPaths"];
let runOptimizationJob: (typeof import("./run-job"))["runOptimizationJob"];
let imageIdFor: (typeof import("./ids"))["imageIdFor"];

function restoreEnvironment(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "ievcs provenance test "));
  const databasePath = path.join(temporaryRoot, "catalog.db");
  const migration = await readFile(
    path.join(
      process.cwd(),
      "prisma",
      "migrations",
      "20260803095000_init",
      "migration.sql",
    ),
    "utf8",
  );
  const setupDatabase = new PrismaClient({
    datasources: { db: { url: `file:${databasePath}` } },
  });
  try {
    for (const statement of migration
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean)) {
      await setupDatabase.$executeRawUnsafe(statement);
    }
  } finally {
    await setupDatabase.$disconnect();
  }

  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.IEVCS_DATA_ROOT = path.join(temporaryRoot, "data");

  ({ db } = await import("@/server/db"));
  ({ projectPaths } = await import("@/server/paths"));
  ({ runOptimizationJob } = await import("./run-job"));
  ({ imageIdFor } = await import("./ids"));
});

afterAll(async () => {
  await db?.$disconnect();
  restoreEnvironment("DATABASE_URL", previousEnvironment.DATABASE_URL);
  restoreEnvironment("IEVCS_DATA_ROOT", previousEnvironment.IEVCS_DATA_ROOT);
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

class PlanThenFailAdapter extends FakeCodexAdapter {
  override async generateImages(
    input: GenerateImagesInput,
  ): Promise<GenerateImagesResult> {
    void input;
    throw new Error("Simulated crash before candidate generation completed");
  }
}

class ChangedAdapter extends FakeCodexAdapter {
  expandCalls = 0;
  generationCalls = 0;
  evaluationCalls = 0;

  override async expandPrompt(
    input: Parameters<FakeCodexAdapter["expandPrompt"]>[0],
  ) {
    this.expandCalls += 1;
    const response = await super.expandPrompt(input);
    return {
      ...response,
      value: {
        expandedPrompt: "CHANGED EXPANDED PROMPT",
        planningSummary: "Changed planning summary",
      },
      prompt: "changed-planner-invocation",
      rawResponse: "changed-planner-response",
    };
  }

  override async generateImages(input: GenerateImagesInput) {
    this.generationCalls += 1;
    return super.generateImages({
      ...input,
      expandedPrompt: "CHANGED GENERATION PROMPT",
    });
  }

  override async evaluateImage(
    input: Parameters<FakeCodexAdapter["evaluateImage"]>[0],
  ): Promise<AdapterResponse<EvaluationResult>> {
    void input;
    this.evaluationCalls += 1;
    return {
      value: {
        score: 1,
        strengths: ["changed"],
        weaknesses: ["changed"],
        recommendedImprovements: ["changed"],
        reasoning: "Changed evaluator response",
      },
      prompt: "changed-evaluator-invocation",
      rawResponse: "changed-evaluator-response",
    };
  }
}

describe("crash-durable candidate provenance", () => {
  it("reuses the exact durable plan, generation, and evaluation bound to recovered bytes", async () => {
    const projectId = randomUUID();
    const jobId = randomUUID();
    const originalPrompt = "An old glasshouse glowing during a snowstorm";
    const payload = jobPayloadSchema.parse({
      mode: "INITIAL",
      originalPrompt,
      referenceIds: [],
      variantsPerRevision: 1,
      optimizationRounds: 1,
      survivorsPerRound: 1,
    });
    await db.project.create({
      data: {
        id: projectId,
        title: "Durable provenance",
        originalPrompt,
        variantsPerRevision: 1,
        optimizationRounds: 1,
        survivorsPerRound: 1,
        jobs: {
          create: {
            id: jobId,
            type: "OPTIMIZE",
            state: "RUNNING",
            payloadJson: JSON.stringify(payload),
            totalRounds: 1,
          },
        },
      },
    });

    await expect(
      runOptimizationJob(jobId, {
        db,
        adapter: new PlanThenFailAdapter(),
        candidateConcurrency: 1,
      }),
    ).rejects.toThrow("All candidates failed");
    // An abrupt worker death leaves the claimed attempt RUNNING. The first
    // invocation above used a normal exception only to seed its durable plan,
    // so restore the crash-equivalent state before recovery.
    await db.candidateAttempt.updateMany({
      where: { jobId },
      data: { state: "RUNNING", error: null },
    });

    const paths = projectPaths(projectId);
    const provenanceRoot = path.join(paths.work, jobId, "provenance");
    const branchDirectory = path.join(provenanceRoot, "round-1", "branch-0");
    const planRecord = JSON.parse(
      await readFile(path.join(branchDirectory, "plan.json"), "utf8"),
    ) as Record<string, unknown>;
    const branchPlanSha256 = sha256(JSON.stringify(planRecord));
    const expandedPrompt = String(planRecord.expandedPrompt);

    const imageId = imageIdFor(jobId, 1, 0, 0);
    const candidateWorkDirectory = path.join(
      paths.work,
      jobId,
      "round-1",
      "branch-0",
      "candidate-0",
    );
    const stagedPath = path.join(candidateWorkDirectory, `${imageId}.png`);
    await new FakeCodexAdapter().generateImages({
      expandedPrompt,
      outputPaths: [stagedPath],
      candidateKeys: [`${jobId}:1:0:0`],
      candidateIndex: 0,
      candidateCount: 1,
    });
    const artifact = await readFile(stagedPath);
    const artifactSha256 = sha256(artifact);
    const candidateProvenanceDirectory = path.join(
      branchDirectory,
      "candidate-0",
    );
    await mkdir(candidateProvenanceDirectory, { recursive: true });

    const commonIdentity = {
      version: 1,
      jobId,
      projectId,
      payloadSha256: sha256(JSON.stringify(payload)),
      localRound: 1,
      branchIndex: 0,
      candidateIndex: 0,
      imageId,
      branchPlanSha256,
      artifactSha256,
    };
    await writeFile(
      path.join(candidateProvenanceDirectory, "generation.json"),
      `${JSON.stringify({
        ...commonIdentity,
        kind: "candidate-generation",
        recovered: false,
        generationMetadata: { adapter: "original", trace: "old-trace" },
        generationRawResponse: "original-generation-response",
        generationInvocationPrompt: "original-generation-invocation",
      })}\n`,
    );
    const originalEvaluation: EvaluationResult = {
      score: 87,
      strengths: ["Original strength"],
      weaknesses: ["Original weakness"],
      recommendedImprovements: ["Original recommendation"],
      reasoning: "Original evaluator reasoning",
    };
    await writeFile(
      path.join(candidateProvenanceDirectory, "evaluation.json"),
      `${JSON.stringify({
        ...commonIdentity,
        kind: "candidate-evaluation",
        evaluation: {
          value: originalEvaluation,
          prompt: "original-evaluator-invocation",
          rawResponse: "original-evaluator-response",
        },
      })}\n`,
    );

    // A plain file at the deterministic thumbnail path simulates a truncated
    // write left by the interrupted process.
    await mkdir(paths.thumbnails, { recursive: true });
    await writeFile(path.join(paths.thumbnails, `${imageId}.webp`), "broken");

    const changedAdapter = new ChangedAdapter();
    let recoveredResult: Awaited<ReturnType<typeof runOptimizationJob>>;
    try {
      recoveredResult = await runOptimizationJob(jobId, {
        db,
        adapter: changedAdapter,
        candidateConcurrency: 1,
      });
    } catch (error) {
      const events = await db.jobEvent.findMany({
        where: { jobId, kind: "CANDIDATE_FAILED" },
        orderBy: { createdAt: "desc" },
      });
      throw new Error(
        `Recovery failed: ${JSON.stringify(events.map(({ dataJson }) => dataJson))}`,
        { cause: error },
      );
    }
    expect(recoveredResult).toEqual({
      revisionIds: [expect.any(String)],
      imageIds: [imageId],
    });
    expect(changedAdapter).toMatchObject({
      expandCalls: 0,
      generationCalls: 0,
      evaluationCalls: 0,
    });

    const image = await db.generatedImage.findUniqueOrThrow({
      where: { id: imageId },
      include: { evaluation: true, revision: true },
    });
    expect(image.revision).toMatchObject({
      expandedPrompt,
      planningPrompt: planRecord.planningPrompt,
      optimizationSummary: planRecord.optimizationSummary,
    });
    expect(JSON.parse(image.generationMeta)).toMatchObject({
      adapter: "original",
      trace: "old-trace",
      invocationPrompt: "original-generation-invocation",
      rawResponse: "original-generation-response",
    });
    expect(image.sha256).toBe(artifactSha256);
    expect(image.evaluation).toMatchObject({
      score: 87,
      strengthsJson: JSON.stringify(originalEvaluation.strengths),
      reasoning: originalEvaluation.reasoning,
      evaluatorPrompt: "original-evaluator-invocation",
      evaluatorResponse: "original-evaluator-response",
    });

    const thumbnail = await sharp(
      path.join(paths.thumbnails, `${imageId}.webp`),
      { failOn: "error" },
    ).metadata();
    expect(thumbnail).toMatchObject({ format: "webp" });
    expect(thumbnail.width).toBeGreaterThan(0);
    expect(thumbnail.height).toBeGreaterThan(0);
  }, 20_000);

  it("catalog-checks and removes every prepared draft after a job-level progress failure", async () => {
    const projectId = randomUUID();
    const jobId = randomUUID();
    const originalPrompt = "A small lighthouse built from folded copper";
    const payload = jobPayloadSchema.parse({
      mode: "INITIAL",
      originalPrompt,
      referenceIds: [],
      variantsPerRevision: 1,
      optimizationRounds: 1,
      survivorsPerRound: 1,
    });
    await db.project.create({
      data: {
        id: projectId,
        title: "Progress failure cleanup",
        originalPrompt,
        variantsPerRevision: 1,
        optimizationRounds: 1,
        survivorsPerRound: 1,
        jobs: {
          create: {
            id: jobId,
            type: "OPTIMIZE",
            state: "RUNNING",
            payloadJson: JSON.stringify(payload),
            totalRounds: 1,
          },
        },
      },
    });

    const triggerName = `fail_progress_${jobId.replaceAll("-", "_")}`;
    await db.$executeRawUnsafe(`
      CREATE TRIGGER ${triggerName}
      BEFORE UPDATE OF progress ON Job
      WHEN NEW.id = '${jobId}' AND NEW.progress > 0
      BEGIN
        SELECT RAISE(FAIL, 'intentional progress failure');
      END
    `);
    try {
      await expect(
        runOptimizationJob(jobId, {
          db,
          adapter: new FakeCodexAdapter(),
          candidateConcurrency: 1,
        }),
      ).rejects.toThrow();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${triggerName}`);
    }

    const paths = projectPaths(projectId);
    const imageId = imageIdFor(jobId, 1, 0, 0);
    const branchDirectory = path.join(
      paths.work,
      jobId,
      "provenance",
      "round-1",
      "branch-0",
    );
    await expect(access(path.join(branchDirectory, "plan.json"))).resolves.toBe(
      undefined,
    );
    await expect(
      access(path.join(branchDirectory, "candidate-0")),
    ).rejects.toThrow();
    await expect(
      access(path.join(paths.images, `${imageId}.png`)),
    ).rejects.toThrow();
    await expect(
      access(path.join(paths.thumbnails, `${imageId}.webp`)),
    ).rejects.toThrow();

    await expect(
      db.generatedImage.count({ where: { id: imageId } }),
    ).resolves.toBe(0);
    await expect(
      db.candidateAttempt.findFirstOrThrow({
        where: { jobId, candidateIndex: 0 },
      }),
    ).resolves.toMatchObject({ state: "FAILED", outputPath: null });
  }, 20_000);
});
