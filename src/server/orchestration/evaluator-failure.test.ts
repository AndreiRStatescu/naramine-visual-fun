import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { PrismaClient } from "@prisma/client";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FakeCodexAdapter } from "@/server/codex/fake-adapter";

const previousEnvironment = {
  CODEX_ADAPTER: process.env.CODEX_ADAPTER,
  DATABASE_URL: process.env.DATABASE_URL,
  IEVCS_DATA_ROOT: process.env.IEVCS_DATA_ROOT,
};

let temporaryRoot: string;
let db: PrismaClient;
let runWorker: (typeof import("@/worker/worker"))["runWorker"];
let projectPaths: (typeof import("@/server/paths"))["projectPaths"];
let imageIdFor: (typeof import("./ids"))["imageIdFor"];

function restoreEnvironment(
  name: keyof typeof previousEnvironment,
  value: string | undefined,
) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeAll(async () => {
  temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "ievcs evaluator failure test "),
  );
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

  process.env.CODEX_ADAPTER = "fake";
  process.env.DATABASE_URL = `file:${databasePath}`;
  process.env.IEVCS_DATA_ROOT = path.join(temporaryRoot, "data");

  ({ db } = await import("@/server/db"));
  ({ runWorker } = await import("@/worker/worker"));
  ({ projectPaths } = await import("@/server/paths"));
  ({ imageIdFor } = await import("./ids"));
});

afterAll(async () => {
  await db?.$disconnect();
  restoreEnvironment("CODEX_ADAPTER", previousEnvironment.CODEX_ADAPTER);
  restoreEnvironment("DATABASE_URL", previousEnvironment.DATABASE_URL);
  restoreEnvironment("IEVCS_DATA_ROOT", previousEnvironment.IEVCS_DATA_ROOT);
  if (temporaryRoot) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

class FailFirstEvaluationAdapter extends FakeCodexAdapter {
  private remainingFailures = 1;

  override async evaluateImage(
    input: Parameters<FakeCodexAdapter["evaluateImage"]>[0],
  ) {
    if (this.remainingFailures > 0) {
      this.remainingFailures -= 1;
      throw new Error("Intentional evaluator failure");
    }
    return super.evaluateImage(input);
  }
}

class ConcurrentGenerationProbeAdapter extends FakeCodexAdapter {
  private activeGenerations = 0;
  private releaseEvaluationGate!: () => void;
  readonly evaluationGate = new Promise<void>((resolve) => {
    this.releaseEvaluationGate = resolve;
  });
  maxActiveGenerations = 0;

  releaseEvaluations() {
    this.releaseEvaluationGate();
  }

  override async generateImages(
    input: Parameters<FakeCodexAdapter["generateImages"]>[0],
  ) {
    this.activeGenerations += 1;
    this.maxActiveGenerations = Math.max(
      this.maxActiveGenerations,
      this.activeGenerations,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return await super.generateImages(input);
    } finally {
      this.activeGenerations -= 1;
    }
  }

  override async evaluateImage(
    input: Parameters<FakeCodexAdapter["evaluateImage"]>[0],
  ) {
    await this.evaluationGate;
    return super.evaluateImage(input);
  }
}

describe("candidate evaluation failure", () => {
  it("cleans provisional files while allowing a successful sibling to complete the job", async () => {
    const projectId = randomUUID();
    const jobId = randomUUID();
    const originalPrompt = "A paper observatory beneath a violet sky";
    await db.project.create({
      data: {
        id: projectId,
        title: "Evaluator cleanup",
        originalPrompt,
        variantsPerRevision: 2,
        optimizationRounds: 1,
        survivorsPerRound: 1,
        jobs: {
          create: {
            id: jobId,
            type: "OPTIMIZE",
            state: "QUEUED",
            payloadJson: JSON.stringify({
              mode: "INITIAL",
              originalPrompt,
              referenceIds: [],
              variantsPerRevision: 2,
              optimizationRounds: 1,
              survivorsPerRound: 1,
            }),
            totalRounds: 1,
          },
        },
      },
    });

    const controller = new AbortController();
    const worker = runWorker({
      adapter: new FailFirstEvaluationAdapter(),
      candidateConcurrency: 1,
      heartbeatMs: 1_000,
      logger: pino({ level: "silent" }),
      pollMs: 5,
      signal: controller.signal,
      staleAfterMs: 60_000,
    });

    let terminalState: string | undefined;
    try {
      for (let poll = 0; poll < 500; poll += 1) {
        const job = await db.job.findUnique({ where: { id: jobId } });
        terminalState = job?.state;
        if (terminalState === "COMPLETED" || terminalState === "FAILED") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      controller.abort();
      await worker;
    }

    expect(terminalState).toBe("COMPLETED");
    const [images, attempts, job] = await Promise.all([
      db.generatedImage.findMany({
        where: { projectId },
        orderBy: { candidateIndex: "asc" },
      }),
      db.candidateAttempt.findMany({
        where: { jobId },
        orderBy: { candidateIndex: "asc" },
      }),
      db.job.findUniqueOrThrow({ where: { id: jobId } }),
    ]);
    expect(job).toMatchObject({ state: "COMPLETED", progress: 100 });
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ candidateIndex: 1, selected: true });
    expect(
      attempts.map(({ candidateIndex, outputPath, state }) => ({
        candidateIndex,
        outputPath,
        state,
      })),
    ).toEqual([
      { candidateIndex: 0, outputPath: null, state: "FAILED" },
      {
        candidateIndex: 1,
        outputPath: images[0]!.filePath,
        state: "COMPLETED",
      },
    ]);

    const paths = projectPaths(projectId);
    const failedImageId = imageIdFor(jobId, 1, 0, 0);
    await expect(
      access(path.join(paths.images, `${failedImageId}.png`)),
    ).rejects.toThrow();
    await expect(
      access(path.join(paths.thumbnails, `${failedImageId}.webp`)),
    ).rejects.toThrow();
    expect(
      (await readdir(paths.images)).filter((name) => name.endsWith(".png")),
    ).toHaveLength(1);
    expect(
      (await readdir(paths.thumbnails)).filter((name) =>
        name.endsWith(".webp"),
      ),
    ).toHaveLength(1);
    await expect(access(path.join(paths.work, jobId))).rejects.toThrow();
  }, 15_000);

  it("publishes generated candidates before evaluation and caps concurrency at four", async () => {
    const projectId = randomUUID();
    const jobId = randomUUID();
    const originalPrompt = "A glass airship above a moonlit desert";
    await db.project.create({
      data: {
        id: projectId,
        title: "Concurrent generation",
        originalPrompt,
        variantsPerRevision: 4,
        optimizationRounds: 1,
        survivorsPerRound: 2,
        jobs: {
          create: {
            id: jobId,
            type: "OPTIMIZE",
            state: "QUEUED",
            payloadJson: JSON.stringify({
              mode: "INITIAL",
              originalPrompt,
              referenceIds: [],
              variantsPerRevision: 4,
              optimizationRounds: 1,
              survivorsPerRound: 2,
            }),
            totalRounds: 1,
          },
        },
      },
    });

    const adapter = new ConcurrentGenerationProbeAdapter();
    const controller = new AbortController();
    const worker = runWorker({
      adapter,
      candidateConcurrency: 4,
      heartbeatMs: 1_000,
      logger: pino({ level: "silent" }),
      pollMs: 5,
      signal: controller.signal,
      staleAfterMs: 60_000,
    });

    try {
      let evaluatingAttempts = await db.candidateAttempt.findMany({
        where: { jobId, state: "EVALUATING" },
      });
      for (
        let poll = 0;
        poll < 500 && evaluatingAttempts.length < 4;
        poll += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        evaluatingAttempts = await db.candidateAttempt.findMany({
          where: { jobId, state: "EVALUATING" },
          orderBy: { candidateIndex: "asc" },
        });
      }

      expect(adapter.maxActiveGenerations).toBe(4);
      expect(evaluatingAttempts).toHaveLength(4);
      expect(evaluatingAttempts.every(({ outputPath }) => outputPath)).toBe(
        true,
      );
      const paths = projectPaths(projectId);
      await Promise.all(
        evaluatingAttempts.flatMap(({ candidateIndex }) => {
          const imageId = imageIdFor(jobId, 1, 0, candidateIndex);
          return [
            expect(
              access(path.join(paths.images, `${imageId}.png`)),
            ).resolves.toBeUndefined(),
            expect(
              access(path.join(paths.thumbnails, `${imageId}.webp`)),
            ).resolves.toBeUndefined(),
          ];
        }),
      );

      adapter.releaseEvaluations();
      let state: string | undefined;
      for (let poll = 0; poll < 500; poll += 1) {
        state = (
          await db.job.findUnique({
            where: { id: jobId },
            select: { state: true },
          })
        )?.state;
        if (state === "COMPLETED" || state === "FAILED") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(state).toBe("COMPLETED");
      const images = await db.generatedImage.findMany({
        where: { projectId },
        orderBy: { candidateIndex: "asc" },
        select: { generationPrompt: true },
      });
      expect(images).toHaveLength(4);
      expect(
        new Set(images.map(({ generationPrompt }) => generationPrompt)).size,
      ).toBe(4);
    } finally {
      adapter.releaseEvaluations();
      controller.abort();
      await worker;
    }
  }, 15_000);
});
