import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import type { CandidateAttempt } from "@prisma/client";
import pino, { type Logger } from "pino";
import sharp, { type Metadata } from "sharp";
import { z } from "zod";

import {
  evaluationResultSchema,
  jobPayloadSchema,
  type EvaluationResult,
  type JobPayload,
} from "@/lib/contracts";
import { selectSurvivors } from "@/lib/domain";
import {
  createCodexAdapter,
  type AdapterResponse,
  type CodexAdapter,
} from "@/server/codex";
import { db as defaultDb } from "@/server/db";
import {
  isPathInside,
  resolveProjectRelativePath,
  toProjectRelativePath,
} from "@/server/paths";
import { createThumbnail, ensureProjectStorage } from "@/server/storage";

import {
  attemptIdFor,
  edgeIdFor,
  evaluationIdFor,
  imageIdFor,
  revisionIdFor,
} from "./ids";

type Database = typeof defaultDb;

type SourceCandidate = {
  id: string;
  revisionId: string;
  revisionRound: number;
  absolutePath: string;
  generationPrompt: string;
  evaluation: EvaluationResult;
  score: number;
};

type ReferenceInput = {
  id: string;
  absolutePath: string;
};

type BranchPlan = {
  localRound: number;
  graphRound: number;
  branchIndex: number;
  revisionId: string;
  source?: SourceCandidate;
  expandedPrompt: string;
  planningPrompt: string;
  optimizationSummary?: string;
  editPrompt?: string;
  planningRawResponse: string;
  provenanceSha256: string;
};

type CandidateDraft = {
  attemptId: string;
  imageId: string;
  candidateIndex: number;
  absolutePath: string;
  relativePath: string;
  thumbnailAbsolutePath: string;
  thumbnailRelativePath: string;
  width: number;
  height: number;
  sha256: string;
  generationMetadata: Record<string, unknown>;
  candidatePrompt: string;
  generationRawResponse: string;
  generationInvocationPrompt: string;
  evaluation: AdapterResponse<EvaluationResult>;
  plan: BranchPlan;
  candidateWorkDirectory: string;
  candidateProvenanceDirectory: string;
};

type FinalizedRound = {
  revisionIds: string[];
  candidates: SourceCandidate[];
};

export type OptimizationJobResult = {
  revisionIds: string[];
  imageIds: string[];
};

export type RunOptimizationJobOptions = {
  db?: Database;
  adapter?: CodexAdapter;
  candidateConcurrency?: number;
};

const PROVENANCE_VERSION = 1 as const;
const MAX_SIDECAR_BYTES = 4 * 1_024 * 1_024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CANDIDATE_CONCURRENCY = 4;

function boundedCandidateConcurrency(value: number | string | undefined) {
  const parsed = Number(value ?? MAX_CANDIDATE_CONCURRENCY);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return MAX_CANDIDATE_CONCURRENCY;
  }
  return Math.min(parsed, MAX_CANDIDATE_CONCURRENCY);
}

async function mapWithConcurrency<Input, Output>(
  values: Input[],
  concurrency: number,
  task: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  if (values.length === 0) return [];
  const results = new Array<Output>(values.length);
  let cursor = 0;
  let stopped = false;
  let firstError: unknown;

  const worker = async () => {
    while (!stopped) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      try {
        results[index] = await task(values[index]!, index);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          firstError = error;
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () =>
      worker(),
    ),
  );
  if (stopped) throw firstError;
  return results;
}

const boundedString = z.string().max(MAX_SIDECAR_BYTES);
const sidecarIdentitySchema = z.object({
  version: z.literal(PROVENANCE_VERSION),
  jobId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
  payloadSha256: z.string().regex(SHA256_PATTERN),
  localRound: z.number().int().positive(),
  branchIndex: z.number().int().nonnegative(),
});

const branchPlanRecordSchema = sidecarIdentitySchema
  .extend({
    kind: z.literal("branch-plan"),
    revisionId: z.string().min(1).max(200),
    graphRound: z.number().int().positive(),
    sourceImageId: z.string().min(1).max(200).nullable(),
    sourceRevisionId: z.string().min(1).max(200).nullable(),
    sourceFingerprint: z.string().regex(SHA256_PATTERN).nullable(),
    expandedPrompt: z.string().min(1).max(12_000),
    planningPrompt: boundedString,
    planningRawResponse: boundedString,
    optimizationSummary: z.string().min(1).max(2_000).nullable(),
    editPrompt: z.string().max(8_000).nullable(),
  })
  .strict();

const candidateIdentitySchema = sidecarIdentitySchema.extend({
  candidateIndex: z.number().int().nonnegative(),
  imageId: z.string().min(1).max(200),
  branchPlanSha256: z.string().regex(SHA256_PATTERN),
  artifactSha256: z.string().regex(SHA256_PATTERN),
});

const generationRecordSchema = candidateIdentitySchema
  .extend({
    kind: z.literal("candidate-generation"),
    recovered: z.boolean(),
    generationMetadata: z.record(z.string(), z.unknown()),
    // Optional so durable records written by the pre-variation worker remain
    // recoverable without paying to regenerate their images.
    candidatePrompt: z.string().min(1).max(12_000).optional(),
    generationRawResponse: boundedString,
    generationInvocationPrompt: boundedString,
  })
  .strict();

const evaluationRecordSchema = candidateIdentitySchema
  .extend({
    kind: z.literal("candidate-evaluation"),
    evaluation: z
      .object({
        value: evaluationResultSchema,
        prompt: boundedString,
        rawResponse: boundedString,
      })
      .strict(),
  })
  .strict();

type BranchPlanRecord = z.infer<typeof branchPlanRecordSchema>;
type GenerationRecord = z.infer<typeof generationRecordSchema>;
type EvaluationRecord = z.infer<typeof evaluationRecordSchema>;

type SidecarIdentity = {
  jobId: string;
  projectId: string;
  payloadSha256: string;
  localRound: number;
  branchIndex: number;
};

type CandidateProvenancePaths = {
  directory: string;
  generation: string;
  evaluation: string;
};

class JobReporter {
  private readonly logger: Logger;
  private readonly destination: ReturnType<typeof pino.destination>;

  constructor(
    private readonly database: Database,
    private readonly jobId: string,
    logPath: string,
  ) {
    this.destination = pino.destination({
      dest: logPath,
      mkdir: true,
      sync: true,
    });
    this.logger = pino(
      { base: { jobId }, timestamp: pino.stdTimeFunctions.isoTime },
      this.destination,
    );
  }

  async event(
    level: "debug" | "info" | "warn" | "error",
    kind: string,
    message: string,
    data?: unknown,
  ): Promise<void> {
    const dataJson = data === undefined ? undefined : JSON.stringify(data);
    await this.database.jobEvent.create({
      data: {
        id: randomUUID(),
        jobId: this.jobId,
        level: level.toUpperCase(),
        kind,
        message,
        dataJson,
      },
    });
    this.logger[level]({ kind, data }, message);
  }

  async progress(currentRound: number, progress: number): Promise<void> {
    const normalized = Math.max(0, Math.min(99, Math.round(progress)));
    await this.database.job.updateMany({
      where: { id: this.jobId, progress: { lt: normalized } },
      data: {
        currentRound,
        progress: normalized,
        lockedAt: new Date(),
      },
    });
  }

  close(): void {
    this.logger.flush();
    this.destination.end();
  }
}

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return message.slice(0, 20_000);
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function payloadFingerprint(payload: JobPayload): string {
  return sha256Text(JSON.stringify(payload));
}

function sourceFingerprint(source: SourceCandidate | undefined): string | null {
  if (!source) return null;
  return sha256Text(
    JSON.stringify({
      id: source.id,
      revisionId: source.revisionId,
      revisionRound: source.revisionRound,
      generationPrompt: source.generationPrompt,
      evaluation: source.evaluation,
      score: source.score,
    }),
  );
}

function branchProvenanceDirectory(
  provenanceRoot: string,
  localRound: number,
  branchIndex: number,
): string {
  return path.join(
    provenanceRoot,
    `round-${localRound}`,
    `branch-${branchIndex}`,
  );
}

function branchPlanPath(
  provenanceRoot: string,
  localRound: number,
  branchIndex: number,
): string {
  return path.join(
    branchProvenanceDirectory(provenanceRoot, localRound, branchIndex),
    "plan.json",
  );
}

function candidateProvenancePaths(
  provenanceRoot: string,
  localRound: number,
  branchIndex: number,
  candidateIndex: number,
): CandidateProvenancePaths {
  const directory = path.join(
    branchProvenanceDirectory(provenanceRoot, localRound, branchIndex),
    `candidate-${candidateIndex}`,
  );
  return {
    directory,
    generation: path.join(directory, "generation.json"),
    evaluation: path.join(directory, "evaluation.json"),
  };
}

async function syncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function loadJsonSidecar<T>(
  sidecarPath: string,
  provenanceRoot: string,
  parse: (value: unknown) => T,
): Promise<T | undefined> {
  let fileStat: Awaited<ReturnType<typeof lstat>>;
  try {
    fileStat = await lstat(sidecarPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !fileStat.isFile() ||
    fileStat.isSymbolicLink() ||
    fileStat.size <= 0 ||
    fileStat.size > MAX_SIDECAR_BYTES
  ) {
    throw new Error(`Invalid provenance sidecar: ${sidecarPath}`);
  }

  const [realRoot, realSidecar] = await Promise.all([
    realpath(provenanceRoot),
    realpath(sidecarPath),
  ]);
  if (!isPathInside(realRoot, realSidecar)) {
    throw new Error("Provenance sidecar escaped its trusted root");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(sidecarPath, "utf8"));
  } catch (error) {
    throw new Error(`Unreadable provenance sidecar: ${sidecarPath}`, {
      cause: error,
    });
  }
  try {
    return parse(decoded);
  } catch (error) {
    throw new Error(`Malformed provenance sidecar: ${sidecarPath}`, {
      cause: error,
    });
  }
}

async function persistJsonSidecar<T>(
  sidecarPath: string,
  provenanceRoot: string,
  value: T,
  parse: (value: unknown) => T,
): Promise<T> {
  const parsed = parse(value);
  const bytes = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
  if (bytes.length > MAX_SIDECAR_BYTES) {
    throw new Error(`Provenance sidecar is too large: ${sidecarPath}`);
  }

  const directory = path.dirname(sidecarPath);
  await mkdir(directory, { recursive: true });
  const [realRoot, realDirectory] = await Promise.all([
    realpath(provenanceRoot),
    realpath(directory),
  ]);
  if (!isPathInside(realRoot, realDirectory)) {
    throw new Error("Provenance directory escaped its trusted root");
  }

  const temporaryPath = path.join(
    directory,
    `.${path.basename(sidecarPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    // The hard link is an atomic, no-overwrite publish. If a prior process
    // already committed this record, its durable value wins and is validated.
    await link(temporaryPath, sidecarPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  await syncDirectory(directory);

  const persisted = await loadJsonSidecar(sidecarPath, provenanceRoot, parse);
  if (!persisted) {
    throw new Error(`Failed to publish provenance sidecar: ${sidecarPath}`);
  }
  return persisted;
}

function assertSidecarIdentity(
  actual: SidecarIdentity,
  expected: SidecarIdentity,
): void {
  for (const key of [
    "jobId",
    "projectId",
    "payloadSha256",
    "localRound",
    "branchIndex",
  ] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Provenance sidecar ${key} binding mismatch`);
    }
  }
}

function assertCandidateIdentity(
  actual: GenerationRecord | EvaluationRecord,
  expected: SidecarIdentity & {
    candidateIndex: number;
    imageId: string;
    branchPlanSha256: string;
    artifactSha256: string;
  },
): void {
  assertSidecarIdentity(actual, expected);
  for (const key of [
    "candidateIndex",
    "imageId",
    "branchPlanSha256",
    "artifactSha256",
  ] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Candidate provenance ${key} binding mismatch`);
    }
  }
}

function branchPlanFromRecord(
  record: BranchPlanRecord,
  expected: SidecarIdentity & {
    revisionId: string;
    graphRound: number;
    source?: SourceCandidate;
  },
): BranchPlan {
  assertSidecarIdentity(record, expected);
  const expectedSourceFingerprint = sourceFingerprint(expected.source);
  if (
    record.revisionId !== expected.revisionId ||
    record.graphRound !== expected.graphRound ||
    record.sourceImageId !== (expected.source?.id ?? null) ||
    record.sourceRevisionId !== (expected.source?.revisionId ?? null) ||
    record.sourceFingerprint !== expectedSourceFingerprint
  ) {
    throw new Error("Branch plan provenance binding mismatch");
  }
  return {
    localRound: record.localRound,
    graphRound: record.graphRound,
    branchIndex: record.branchIndex,
    revisionId: record.revisionId,
    source: expected.source,
    expandedPrompt: record.expandedPrompt,
    planningPrompt: record.planningPrompt,
    planningRawResponse: record.planningRawResponse,
    optimizationSummary: record.optimizationSummary ?? undefined,
    editPrompt: record.editPrompt ?? undefined,
    provenanceSha256: sha256Text(JSON.stringify(record)),
  };
}

async function loadBranchPlan(
  provenanceRoot: string,
  expected: SidecarIdentity & {
    revisionId: string;
    graphRound: number;
    source?: SourceCandidate;
  },
): Promise<BranchPlan | undefined> {
  const record = await loadJsonSidecar(
    branchPlanPath(provenanceRoot, expected.localRound, expected.branchIndex),
    provenanceRoot,
    (value) => branchPlanRecordSchema.parse(value),
  );
  return record ? branchPlanFromRecord(record, expected) : undefined;
}

async function persistBranchPlan(
  provenanceRoot: string,
  expected: SidecarIdentity & {
    revisionId: string;
    graphRound: number;
    source?: SourceCandidate;
  },
  response: {
    expandedPrompt: string;
    planningPrompt: string;
    planningRawResponse: string;
    optimizationSummary?: string;
    editPrompt?: string;
  },
): Promise<BranchPlan> {
  const record: BranchPlanRecord = {
    version: PROVENANCE_VERSION,
    kind: "branch-plan",
    jobId: expected.jobId,
    projectId: expected.projectId,
    payloadSha256: expected.payloadSha256,
    localRound: expected.localRound,
    branchIndex: expected.branchIndex,
    revisionId: expected.revisionId,
    graphRound: expected.graphRound,
    sourceImageId: expected.source?.id ?? null,
    sourceRevisionId: expected.source?.revisionId ?? null,
    sourceFingerprint: sourceFingerprint(expected.source),
    expandedPrompt: response.expandedPrompt,
    planningPrompt: response.planningPrompt,
    planningRawResponse: response.planningRawResponse,
    optimizationSummary: response.optimizationSummary ?? null,
    editPrompt: response.editPrompt ?? null,
  };
  const persisted = await persistJsonSidecar(
    branchPlanPath(provenanceRoot, expected.localRound, expected.branchIndex),
    provenanceRoot,
    record,
    (value) => branchPlanRecordSchema.parse(value),
  );
  return branchPlanFromRecord(persisted, expected);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function validPng(filePath: string): Promise<Metadata | undefined> {
  try {
    const metadata = await sharp(filePath, { failOn: "error" }).metadata();
    return metadata.format === "png" && metadata.width && metadata.height
      ? metadata
      : undefined;
  } catch {
    return undefined;
  }
}

async function validWebp(filePath: string): Promise<Metadata | undefined> {
  try {
    const metadata = await sharp(filePath, { failOn: "error" }).metadata();
    return metadata.format === "webp" && metadata.width && metadata.height
      ? metadata
      : undefined;
  } catch {
    return undefined;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function parseEvaluationFromDatabase(value: {
  score: number;
  strengthsJson: string;
  weaknessesJson: string;
  recommendationsJson: string;
  reasoning: string;
}): EvaluationResult {
  const stringArray = (json: string): string[] => {
    try {
      const decoded: unknown = JSON.parse(json);
      return Array.isArray(decoded)
        ? decoded.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  };
  return {
    score: value.score,
    strengths: stringArray(value.strengthsJson),
    weaknesses: stringArray(value.weaknessesJson),
    recommendedImprovements: stringArray(value.recommendationsJson),
    reasoning: value.reasoning,
  };
}

function expectedAttemptIds(
  jobId: string,
  localRound: number,
  branchCount: number,
  variantsPerRevision: number,
): string[] {
  const ids: string[] = [];
  for (let branch = 0; branch < branchCount; branch += 1) {
    for (let candidate = 0; candidate < variantsPerRevision; candidate += 1) {
      ids.push(attemptIdFor(jobId, localRound, branch, candidate));
    }
  }
  return ids;
}

async function loadFinalizedRound(
  database: Database,
  projectId: string,
  jobId: string,
  localRound: number,
  branchCount: number,
  variantsPerRevision: number,
): Promise<FinalizedRound | undefined> {
  const attemptIds = expectedAttemptIds(
    jobId,
    localRound,
    branchCount,
    variantsPerRevision,
  );
  const attempts = await database.candidateAttempt.findMany({
    where: { id: { in: attemptIds } },
  });
  if (
    attempts.length !== attemptIds.length ||
    attempts.some(({ state }) => state !== "COMPLETED" && state !== "FAILED")
  ) {
    return undefined;
  }

  const expectedRevisionIds = Array.from({ length: branchCount }, (_, branch) =>
    revisionIdFor(jobId, localRound, branch),
  );
  const revisions = await database.revision.findMany({
    where: { id: { in: expectedRevisionIds }, projectId },
    include: {
      images: {
        include: { evaluation: true },
        orderBy: { candidateIndex: "asc" },
      },
    },
  });
  const imagesById = new Set(
    revisions.flatMap(({ images }) => images.map(({ id }) => id)),
  );
  for (const attempt of attempts) {
    if (
      attempt.state === "COMPLETED" &&
      !imagesById.has(
        imageIdFor(
          jobId,
          localRound,
          attempt.branchIndex,
          attempt.candidateIndex,
        ),
      )
    ) {
      throw new Error(
        `Finalized candidate ${attempt.id} has no immutable image record`,
      );
    }
  }

  const candidates: SourceCandidate[] = [];
  for (const revision of revisions) {
    for (const image of revision.images) {
      if (!image.evaluation) {
        throw new Error(`Finalized image ${image.id} has no evaluation`);
      }
      candidates.push({
        id: image.id,
        revisionId: revision.id,
        revisionRound: revision.round,
        absolutePath: resolveProjectRelativePath(projectId, image.filePath),
        generationPrompt: image.generationPrompt,
        evaluation: parseEvaluationFromDatabase(image.evaluation),
        score: image.evaluation.score,
      });
    }
  }
  return {
    revisionIds: revisions.map(({ id }) => id),
    candidates,
  };
}

async function loadSourceCandidate(
  database: Database,
  projectId: string,
  sourceImageId: string,
): Promise<SourceCandidate> {
  const image = await database.generatedImage.findUnique({
    where: { id: sourceImageId },
    include: { evaluation: true, revision: true },
  });
  if (!image || image.projectId !== projectId) {
    throw new Error("The explore source image does not belong to this project");
  }
  const evaluation = image.evaluation
    ? parseEvaluationFromDatabase(image.evaluation)
    : {
        score: 0,
        strengths: [],
        weaknesses: [],
        recommendedImprovements: [],
        reasoning: "No prior evaluation was recorded.",
      };
  return {
    id: image.id,
    revisionId: image.revisionId,
    revisionRound: image.revision.round,
    absolutePath: resolveProjectRelativePath(projectId, image.filePath),
    generationPrompt: image.generationPrompt,
    evaluation,
    score: evaluation.score,
  };
}

async function loadReferences(
  database: Database,
  projectId: string,
  referenceIds: string[],
): Promise<ReferenceInput[]> {
  const references = await database.referenceAsset.findMany({
    where: { projectId, id: { in: referenceIds } },
  });
  const byId = new Map(
    references.map((reference) => [reference.id, reference]),
  );
  return referenceIds.map((id) => {
    const reference = byId.get(id);
    if (!reference) {
      throw new Error(`Reference ${id} does not belong to this project`);
    }
    return {
      id,
      absolutePath: resolveProjectRelativePath(projectId, reference.filePath),
    };
  });
}

async function beginAttempt(
  database: Database,
  input: {
    id: string;
    jobId: string;
    localRound: number;
    branchIndex: number;
    candidateIndex: number;
    parentImageId?: string;
    prompt: string;
  },
): Promise<CandidateAttempt> {
  return database.candidateAttempt.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      jobId: input.jobId,
      round: input.localRound,
      branchIndex: input.branchIndex,
      candidateIndex: input.candidateIndex,
      parentImageId: input.parentImageId,
      state: "GENERATING",
      prompt: input.prompt,
      attemptCount: 1,
    },
    update: {
      state: "GENERATING",
      error: null,
      prompt: input.prompt,
      parentImageId: input.parentImageId,
      attemptCount: { increment: 1 },
    },
  });
}

async function failAttempt(
  database: Database,
  attemptId: string,
  error: unknown,
  outputPath?: string,
): Promise<void> {
  await database.candidateAttempt.update({
    where: { id: attemptId },
    data: {
      state: "FAILED",
      error: errorMessage(error),
      outputPath: outputPath ?? null,
    },
  });
}

export async function publishCandidate(
  stagedPath: string,
  destinationPath: string,
  expectedStagingDirectory: string,
): Promise<void> {
  const [stagedStat, realStagedPath, realStagingDirectory] = await Promise.all([
    lstat(stagedPath),
    realpath(stagedPath),
    realpath(expectedStagingDirectory),
  ]);
  if (
    !stagedStat.isFile() ||
    stagedStat.isSymbolicLink() ||
    stagedStat.nlink !== 1 ||
    !isPathInside(realStagingDirectory, realStagedPath)
  ) {
    throw new Error("Generated candidate is not an isolated regular file");
  }

  try {
    // A trusted exclusive copy gives the immutable original a fresh inode and
    // never grants Codex write access to the destination directory.
    await copyFile(stagedPath, destinationPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await validPng(destinationPath))) throw error;
  }
  if (!(await validPng(destinationPath))) {
    throw new Error("Published candidate failed image validation");
  }
  await rm(stagedPath, { force: true });
}

async function prepareCandidate(
  database: Database,
  adapter: CodexAdapter,
  projectId: string,
  jobId: string,
  payloadSha256: string,
  originalPrompt: string,
  plan: BranchPlan,
  candidateIndex: number,
  candidateCount: number,
  references: ReferenceInput[],
  projectStorage: Awaited<ReturnType<typeof ensureProjectStorage>>,
): Promise<CandidateDraft> {
  const imageId = imageIdFor(
    jobId,
    plan.localRound,
    plan.branchIndex,
    candidateIndex,
  );
  const attemptId = attemptIdFor(
    jobId,
    plan.localRound,
    plan.branchIndex,
    candidateIndex,
  );
  const absolutePath = path.join(projectStorage.images, `${imageId}.png`);
  const candidateWorkDirectory = path.join(
    projectStorage.work,
    jobId,
    `round-${plan.localRound}`,
    `branch-${plan.branchIndex}`,
    `candidate-${candidateIndex}`,
  );
  const stagedPath = path.join(candidateWorkDirectory, `${imageId}.png`);
  const thumbnailAbsolutePath = path.join(
    projectStorage.thumbnails,
    `${imageId}.webp`,
  );
  const provenanceRoot = path.join(projectStorage.work, jobId, "provenance");
  const provenancePaths = candidateProvenancePaths(
    provenanceRoot,
    plan.localRound,
    plan.branchIndex,
    candidateIndex,
  );
  const candidateIdentity = {
    jobId,
    projectId,
    payloadSha256,
    localRound: plan.localRound,
    branchIndex: plan.branchIndex,
    candidateIndex,
    imageId,
    branchPlanSha256: plan.provenanceSha256,
  };
  await beginAttempt(database, {
    id: attemptId,
    jobId,
    localRound: plan.localRound,
    branchIndex: plan.branchIndex,
    candidateIndex,
    parentImageId: plan.source?.id,
    prompt: plan.expandedPrompt,
  });

  try {
    let publishedMetadata = await validPng(absolutePath);
    let stagedMetadata = await validPng(stagedPath);
    if (!publishedMetadata && (await fileExists(absolutePath))) {
      await rm(absolutePath, { force: true });
    }
    if (!stagedMetadata && (await fileExists(stagedPath))) {
      await rm(stagedPath, { force: true });
    }

    if (publishedMetadata && stagedMetadata) {
      const [publishedSha256, stagedSha256] = await Promise.all([
        sha256File(absolutePath),
        sha256File(stagedPath),
      ]);
      if (publishedSha256 !== stagedSha256) {
        throw new Error("Published and staged candidate artifacts disagree");
      }
      // copyFile may have completed just before a crash but not yet removed
      // the staged source. The published fresh inode is authoritative.
      await rm(stagedPath, { force: true });
      stagedMetadata = undefined;
    }

    let artifactPath = publishedMetadata
      ? absolutePath
      : stagedMetadata
        ? stagedPath
        : undefined;
    let artifactSha256 = artifactPath
      ? await sha256File(artifactPath)
      : undefined;
    let generationRecord = await loadJsonSidecar(
      provenancePaths.generation,
      provenanceRoot,
      (value) => generationRecordSchema.parse(value),
    );

    if (!artifactPath || !artifactSha256) {
      if (generationRecord) {
        throw new Error(
          "Generation provenance exists without its bound candidate artifact",
        );
      }
      await mkdir(candidateWorkDirectory, { recursive: true });
      const generation = await adapter.generateImages({
        expandedPrompt: plan.expandedPrompt,
        outputPaths: [stagedPath],
        candidateKeys: [
          `${jobId}:${plan.localRound}:${plan.branchIndex}:${candidateIndex}`,
        ],
        candidateIndex,
        candidateCount,
        parentImagePath: plan.source?.absolutePath,
        referenceImagePaths: references.map(({ absolutePath }) => absolutePath),
      });
      stagedMetadata = await validPng(stagedPath);
      if (!stagedMetadata) {
        throw new Error(
          `Candidate ${imageId} did not produce a valid staged PNG`,
        );
      }
      artifactPath = stagedPath;
      artifactSha256 = await sha256File(stagedPath);
      generationRecord = await persistJsonSidecar(
        provenancePaths.generation,
        provenanceRoot,
        {
          version: PROVENANCE_VERSION,
          kind: "candidate-generation",
          ...candidateIdentity,
          artifactSha256,
          recovered: false,
          generationMetadata:
            generation.value.images[0]?.generationMetadata ?? {},
          candidatePrompt:
            generation.value.images[0]?.finalPrompt ?? plan.expandedPrompt,
          generationRawResponse: generation.rawResponse,
          generationInvocationPrompt: generation.prompt,
        } satisfies GenerationRecord,
        (value) => generationRecordSchema.parse(value),
      );
    } else if (!generationRecord) {
      // A generator can write the PNG and then die before returning its
      // response. Bind a narrow recovery marker to the durable branch prompt
      // and exact artifact instead of calling a changed generator again.
      generationRecord = await persistJsonSidecar(
        provenancePaths.generation,
        provenanceRoot,
        {
          version: PROVENANCE_VERSION,
          kind: "candidate-generation",
          ...candidateIdentity,
          artifactSha256,
          recovered: true,
          generationMetadata: { recovered: true },
          candidatePrompt: plan.expandedPrompt,
          generationRawResponse: JSON.stringify({ recovered: true }),
          generationInvocationPrompt: plan.expandedPrompt,
        } satisfies GenerationRecord,
        (value) => generationRecordSchema.parse(value),
      );
    }
    assertCandidateIdentity(generationRecord, {
      ...candidateIdentity,
      artifactSha256,
    });
    const candidatePrompt =
      generationRecord.candidatePrompt ?? plan.expandedPrompt;

    // Publish the trusted artifact and thumbnail before evaluation so the UI
    // can display the real image while the critic runs. The revision remains
    // provisional until the whole batch is ranked and atomically finalized.
    if ((await sha256File(artifactPath)) !== artifactSha256) {
      throw new Error("Candidate artifact changed after provenance capture");
    }
    if (artifactPath === stagedPath) {
      await publishCandidate(stagedPath, absolutePath, candidateWorkDirectory);
      artifactPath = absolutePath;
      publishedMetadata = await validPng(absolutePath);
    }
    if (!publishedMetadata?.width || !publishedMetadata.height) {
      throw new Error(`Candidate ${imageId} did not produce a valid PNG`);
    }
    if ((await sha256File(absolutePath)) !== artifactSha256) {
      throw new Error("Published candidate no longer matches its provenance");
    }

    let thumbnailMetadata = await validWebp(thumbnailAbsolutePath);
    if (!thumbnailMetadata) {
      await rm(thumbnailAbsolutePath, { force: true });
      await createThumbnail(absolutePath, thumbnailAbsolutePath);
      thumbnailMetadata = await validWebp(thumbnailAbsolutePath);
    }
    if (!thumbnailMetadata?.width || !thumbnailMetadata.height) {
      throw new Error(`Candidate ${imageId} has an invalid thumbnail`);
    }

    const sha256 = await sha256File(absolutePath);
    const relativePath = toProjectRelativePath(projectId, absolutePath);
    const thumbnailRelativePath = toProjectRelativePath(
      projectId,
      thumbnailAbsolutePath,
    );
    await database.candidateAttempt.update({
      where: { id: attemptId },
      data: {
        state: "EVALUATING",
        prompt: candidatePrompt,
        outputPath: relativePath,
        error: null,
      },
    });

    let evaluationRecord = await loadJsonSidecar(
      provenancePaths.evaluation,
      provenanceRoot,
      (value) => evaluationRecordSchema.parse(value),
    );
    if (evaluationRecord) {
      assertCandidateIdentity(evaluationRecord, {
        ...candidateIdentity,
        artifactSha256,
      });
    } else {
      const evaluation = await adapter.evaluateImage({
        originalPrompt,
        imagePath: absolutePath,
      });
      if ((await sha256File(absolutePath)) !== artifactSha256) {
        throw new Error("Evaluator mutated its candidate artifact");
      }
      evaluationRecord = await persistJsonSidecar(
        provenancePaths.evaluation,
        provenanceRoot,
        {
          version: PROVENANCE_VERSION,
          kind: "candidate-evaluation",
          ...candidateIdentity,
          artifactSha256,
          evaluation,
        } satisfies EvaluationRecord,
        (value) => evaluationRecordSchema.parse(value),
      );
      assertCandidateIdentity(evaluationRecord, {
        ...candidateIdentity,
        artifactSha256,
      });
    }

    if ((await sha256File(absolutePath)) !== artifactSha256) {
      throw new Error("Candidate artifact changed after evaluation");
    }
    await database.candidateAttempt.update({
      where: { id: attemptId },
      data: { state: "PREPARED", outputPath: relativePath, error: null },
    });

    return {
      attemptId,
      imageId,
      candidateIndex,
      absolutePath,
      relativePath,
      thumbnailAbsolutePath,
      thumbnailRelativePath,
      width: publishedMetadata.width,
      height: publishedMetadata.height,
      sha256,
      generationMetadata: generationRecord.generationMetadata,
      candidatePrompt,
      generationRawResponse: generationRecord.generationRawResponse,
      generationInvocationPrompt: generationRecord.generationInvocationPrompt,
      evaluation: evaluationRecord.evaluation,
      plan,
      candidateWorkDirectory,
      candidateProvenanceDirectory: provenancePaths.directory,
    };
  } catch (error) {
    // These deterministic paths are still provisional: finalized rounds are
    // detected before prepareCandidate is called. Check the catalog as a final
    // guard against deleting an artifact after an ambiguous database result.
    const persisted = await database.generatedImage.findUnique({
      where: { id: imageId },
      select: { id: true },
    });
    await Promise.all([
      ...(persisted
        ? []
        : [
            rm(absolutePath, { force: true }),
            rm(thumbnailAbsolutePath, { force: true }),
          ]),
      rm(candidateWorkDirectory, { recursive: true, force: true }),
      rm(provenancePaths.directory, { recursive: true, force: true }),
    ]);
    throw error;
  }
}

function edgeLabel(plan: BranchPlan): string {
  const label =
    plan.editPrompt ?? plan.optimizationSummary ?? "Optimized variant";
  return label.length <= 120 ? label : `${label.slice(0, 117)}...`;
}

async function finalizeRound(
  database: Database,
  input: {
    jobId: string;
    projectId: string;
    payload: JobPayload;
    plans: BranchPlan[];
    drafts: CandidateDraft[];
    references: ReferenceInput[];
    selectedIds: Set<string>;
    jobLogPath: string;
  },
): Promise<FinalizedRound> {
  const draftsByRevision = new Map<string, CandidateDraft[]>();
  for (const draft of input.drafts) {
    const drafts = draftsByRevision.get(draft.plan.revisionId) ?? [];
    drafts.push(draft);
    draftsByRevision.set(draft.plan.revisionId, drafts);
  }

  const successfulPlans = input.plans.filter(
    (plan) => (draftsByRevision.get(plan.revisionId)?.length ?? 0) > 0,
  );
  await database.$transaction(async (transaction) => {
    for (const plan of successfulPlans) {
      await transaction.revision.create({
        data: {
          id: plan.revisionId,
          projectId: input.projectId,
          parentRevisionId: plan.source?.revisionId,
          sourceImageId: plan.source?.id,
          round: plan.graphRound,
          branchIndex: plan.branchIndex,
          originalPrompt: input.payload.originalPrompt,
          editPrompt: plan.editPrompt,
          planningPrompt: plan.planningPrompt,
          expandedPrompt: plan.expandedPrompt,
          optimizationSummary: plan.optimizationSummary,
          jobLogPath: input.jobLogPath,
          references: {
            create: input.references.map(({ id }, ordinal) => ({
              referenceId: id,
              ordinal,
              role: "visual",
            })),
          },
        },
      });

      for (const draft of draftsByRevision.get(plan.revisionId) ?? []) {
        await transaction.generatedImage.create({
          data: {
            id: draft.imageId,
            projectId: input.projectId,
            revisionId: plan.revisionId,
            candidateIndex: draft.candidateIndex,
            filePath: draft.relativePath,
            thumbnailPath: draft.thumbnailRelativePath,
            mimeType: "image/png",
            width: draft.width,
            height: draft.height,
            sha256: draft.sha256,
            generationPrompt: draft.candidatePrompt,
            generationMeta: JSON.stringify({
              ...draft.generationMetadata,
              invocationPrompt: draft.generationInvocationPrompt,
              rawResponse: draft.generationRawResponse,
            }),
            selected: input.selectedIds.has(draft.imageId),
            evaluation: {
              create: {
                id: evaluationIdFor(draft.imageId),
                score: draft.evaluation.value.score,
                strengthsJson: JSON.stringify(draft.evaluation.value.strengths),
                weaknessesJson: JSON.stringify(
                  draft.evaluation.value.weaknesses,
                ),
                recommendationsJson: JSON.stringify(
                  draft.evaluation.value.recommendedImprovements,
                ),
                reasoning: draft.evaluation.value.reasoning,
                evaluatorPrompt: draft.evaluation.prompt,
                evaluatorResponse: draft.evaluation.rawResponse,
              },
            },
          },
        });
        if (plan.source) {
          await transaction.creativeEdge.create({
            data: {
              id: edgeIdFor(draft.imageId),
              projectId: input.projectId,
              revisionId: plan.revisionId,
              sourceImageId: plan.source.id,
              targetImageId: draft.imageId,
              label: edgeLabel(plan),
              metadataJson: JSON.stringify({
                editPrompt: plan.editPrompt ?? null,
                plannerOutput: plan.expandedPrompt,
                optimizationSummary: plan.optimizationSummary ?? null,
                jobId: input.jobId,
                localRound: plan.localRound,
              }),
            },
          });
        }
        await transaction.candidateAttempt.update({
          where: { id: draft.attemptId },
          data: {
            state: "COMPLETED",
            outputPath: draft.relativePath,
            error: null,
          },
        });
      }
    }
  });

  return {
    revisionIds: successfulPlans.map(({ revisionId }) => revisionId),
    candidates: input.drafts.map((draft) => ({
      id: draft.imageId,
      revisionId: draft.plan.revisionId,
      revisionRound: draft.plan.graphRound,
      absolutePath: draft.absolutePath,
      generationPrompt: draft.candidatePrompt,
      evaluation: draft.evaluation.value,
      score: draft.evaluation.value.score,
    })),
  };
}

async function cleanRolledBackDrafts(
  database: Database,
  drafts: CandidateDraft[],
  error: unknown,
): Promise<void> {
  if (drafts.length === 0) return;

  // A SQLite transaction is atomic, but check the catalog before removing a
  // file so an ambiguous driver error can never delete a committed original.
  const persisted = await database.generatedImage.findMany({
    where: { id: { in: drafts.map(({ imageId }) => imageId) } },
    select: { id: true },
  });
  const persistedIds = new Set(persisted.map(({ id }) => id));
  const rolledBack = drafts.filter(({ imageId }) => !persistedIds.has(imageId));
  await Promise.all(
    rolledBack.flatMap(
      ({
        absolutePath,
        thumbnailAbsolutePath,
        candidateWorkDirectory,
        candidateProvenanceDirectory,
      }) => [
        rm(absolutePath, { force: true }),
        rm(thumbnailAbsolutePath, { force: true }),
        rm(candidateWorkDirectory, { recursive: true, force: true }),
        // Candidate records are meaningful only while their provisional
        // artifact exists. The sibling branch plan deliberately remains.
        rm(candidateProvenanceDirectory, { recursive: true, force: true }),
      ],
    ),
  );
  if (rolledBack.length > 0) {
    await database.candidateAttempt.updateMany({
      where: { id: { in: rolledBack.map(({ attemptId }) => attemptId) } },
      data: {
        state: "FAILED",
        outputPath: null,
        error: errorMessage(error),
      },
    });
  }
}

function selectedCandidates(
  candidates: SourceCandidate[],
  survivorCount: number,
): SourceCandidate[] {
  return selectSurvivors(
    candidates.map((candidate) => ({
      value: candidate,
      score: candidate.score,
      stableId: candidate.id,
    })),
    survivorCount,
  ).map(({ value }) => value);
}

/**
 * Execute one already-claimed job. Candidate artifacts stay provisional until
 * an entire local round has been evaluated and globally ranked; the immutable
 * revisions, images, evaluations, edges, and final selection bits are then
 * inserted in one SQLite transaction.
 */
export async function runOptimizationJob(
  jobId: string,
  options: RunOptimizationJobOptions = {},
): Promise<OptimizationJobResult> {
  const database = options.db ?? defaultDb;
  const adapter = options.adapter ?? createCodexAdapter();
  const job = await database.job.findUnique({
    where: { id: jobId },
    include: { project: true },
  });
  if (!job) throw new Error(`Job ${jobId} does not exist`);
  if (job.state !== "RUNNING") {
    throw new Error(`Job ${jobId} must be RUNNING, not ${job.state}`);
  }
  const payload = jobPayloadSchema.parse(JSON.parse(job.payloadJson));
  const candidateConcurrency = boundedCandidateConcurrency(
    options.candidateConcurrency ?? process.env.CODEX_IMAGE_CONCURRENCY,
  );
  if (payload.mode === "INITIAL" && job.type !== "OPTIMIZE") {
    throw new Error("INITIAL payload requires an OPTIMIZE job");
  }
  if (payload.mode === "EXPLORE" && job.type !== "EXPLORE") {
    throw new Error("EXPLORE payload requires an EXPLORE job");
  }
  if (payload.originalPrompt !== job.project.originalPrompt) {
    throw new Error("Job prompt no longer matches its project");
  }

  const storage = await ensureProjectStorage(job.projectId);
  const provenanceRoot = path.join(storage.work, job.id, "provenance");
  await mkdir(provenanceRoot, { recursive: true });
  const payloadSha256 = payloadFingerprint(payload);
  const logAbsolutePath = path.join(storage.logs, `${job.id}.jsonl`);
  const jobLogPath = toProjectRelativePath(job.projectId, logAbsolutePath);
  const reporter = new JobReporter(database, job.id, logAbsolutePath);
  const references = await loadReferences(
    database,
    job.projectId,
    payload.referenceIds,
  );
  const referencePaths = references.map(({ absolutePath }) => absolutePath);
  const expectedCandidates =
    payload.variantsPerRevision +
    Math.max(0, payload.optimizationRounds - 1) *
      payload.survivorsPerRound *
      payload.variantsPerRevision;
  let processedCandidates = 0;
  let frontier: SourceCandidate[] = [];
  const allRevisionIds: string[] = [];
  const allImageIds: string[] = [];
  let preparedButNotFinalized: CandidateDraft[] = [];

  try {
    let initialSource: SourceCandidate | undefined;
    if (payload.mode === "EXPLORE") {
      initialSource = await loadSourceCandidate(
        database,
        job.projectId,
        payload.sourceImageId!,
      );
    }
    await reporter.event("info", "JOB_STARTED", "Optimization job started", {
      mode: payload.mode,
      rounds: payload.optimizationRounds,
      variantsPerRevision: payload.variantsPerRevision,
      survivorsPerRound: payload.survivorsPerRound,
      candidateConcurrency,
    });

    if (payload.mode === "INITIAL") {
      const alreadyTitled = await database.jobEvent.findFirst({
        where: { jobId: job.id, kind: "PROJECT_TITLE_SUMMARIZED" },
        select: { id: true },
      });
      if (!alreadyTitled) {
        try {
          const title = await adapter.summarizeProjectTitle(
            payload.originalPrompt,
          );
          await database.project.update({
            where: { id: job.projectId },
            data: { title: title.value.title },
          });
          await reporter.event(
            "info",
            "PROJECT_TITLE_SUMMARIZED",
            "Project title summarized",
            {
              title: title.value.title,
              prompt: title.prompt,
              rawResponse: title.rawResponse,
            },
          );
        } catch (error) {
          // Title generation is catalog polish, not part of image provenance;
          // retain the existing fallback title and continue the job.
          await reporter.event(
            "warn",
            "PROJECT_TITLE_SUMMARY_FAILED",
            "Project title summarization failed; kept the fallback title",
            { error: errorMessage(error), fallbackTitle: job.project.title },
          );
        }
      }
    }

    for (
      let localRound = 1;
      localRound <= payload.optimizationRounds;
      localRound += 1
    ) {
      const sources = localRound === 1 ? [initialSource] : frontier;
      const branchCount = sources.length;
      if (branchCount === 0) {
        throw new Error(
          `Round ${localRound} has no surviving source candidates`,
        );
      }

      const recovered = await loadFinalizedRound(
        database,
        job.projectId,
        job.id,
        localRound,
        branchCount,
        payload.variantsPerRevision,
      );
      if (recovered) {
        frontier = selectedCandidates(
          recovered.candidates,
          payload.survivorsPerRound,
        );
        allRevisionIds.push(...recovered.revisionIds);
        allImageIds.push(...recovered.candidates.map(({ id }) => id));
        processedCandidates += branchCount * payload.variantsPerRevision;
        await reporter.progress(
          localRound,
          (processedCandidates / expectedCandidates) * 99,
        );
        await reporter.event(
          "info",
          "ROUND_RECOVERED",
          `Reused finalized round ${localRound}`,
          { images: recovered.candidates.length },
        );
        if (frontier.length === 0) {
          throw new Error(`All candidates failed in round ${localRound}`);
        }
        continue;
      }

      const plans: BranchPlan[] = [];
      if (localRound === 1) {
        const expectedPlan = {
          jobId: job.id,
          projectId: job.projectId,
          payloadSha256,
          localRound,
          branchIndex: 0,
          graphRound: initialSource ? initialSource.revisionRound + 1 : 1,
          revisionId: revisionIdFor(job.id, localRound, 0),
          source: initialSource,
        };
        let plan = await loadBranchPlan(provenanceRoot, expectedPlan);
        if (plan) {
          await reporter.event(
            "info",
            "BRANCH_PLAN_RECOVERED",
            "Reused the durable initial branch plan",
            {
              localRound,
              branchIndex: 0,
              prompt: plan.planningPrompt,
              rawResponse: plan.planningRawResponse,
              expandedPrompt: plan.expandedPrompt,
              optimizationSummary: plan.optimizationSummary,
              editPrompt: plan.editPrompt,
            },
          );
        } else {
          const expanded = await adapter.expandPrompt({
            originalPrompt: payload.originalPrompt,
            editPrompt: payload.editPrompt,
            parentImagePath: initialSource?.absolutePath,
            referenceImagePaths: referencePaths,
          });
          plan = await persistBranchPlan(provenanceRoot, expectedPlan, {
            expandedPrompt: expanded.value.expandedPrompt,
            planningPrompt: expanded.prompt,
            planningRawResponse: expanded.rawResponse,
            optimizationSummary: expanded.value.planningSummary,
            editPrompt: payload.editPrompt,
          });
          await reporter.event(
            "info",
            "PROMPT_EXPANDED",
            "Initial prompt expanded",
            {
              localRound,
              response: expanded.rawResponse,
            },
          );
        }
        plans.push(plan);
      } else {
        for (
          let branchIndex = 0;
          branchIndex < sources.length;
          branchIndex += 1
        ) {
          const source = sources[branchIndex]!;
          try {
            const expectedPlan = {
              jobId: job.id,
              projectId: job.projectId,
              payloadSha256,
              localRound,
              branchIndex,
              graphRound: source.revisionRound + 1,
              revisionId: revisionIdFor(job.id, localRound, branchIndex),
              source,
            };
            let plan = await loadBranchPlan(provenanceRoot, expectedPlan);
            if (plan) {
              await reporter.event(
                "info",
                "BRANCH_PLAN_RECOVERED",
                `Reused branch plan for round ${localRound}, branch ${branchIndex}`,
                {
                  localRound,
                  branchIndex,
                  sourceImageId: source.id,
                  prompt: plan.planningPrompt,
                  rawResponse: plan.planningRawResponse,
                  expandedPrompt: plan.expandedPrompt,
                  optimizationSummary: plan.optimizationSummary,
                },
              );
            } else {
              const rewritten = await adapter.rewritePrompt({
                originalPrompt: payload.originalPrompt,
                currentPrompt: source.generationPrompt,
                imagePath: source.absolutePath,
                evaluation: source.evaluation,
                nextRound: localRound,
              });
              plan = await persistBranchPlan(provenanceRoot, expectedPlan, {
                expandedPrompt: rewritten.value.rewrittenPrompt,
                planningPrompt: rewritten.prompt,
                planningRawResponse: rewritten.rawResponse,
                optimizationSummary: rewritten.value.optimizationSummary,
              });
              await reporter.event(
                "info",
                "PROMPT_REWRITTEN",
                `Rewrote prompt for round ${localRound}, branch ${branchIndex}`,
                {
                  localRound,
                  branchIndex,
                  sourceImageId: source.id,
                  prompt: rewritten.prompt,
                  rawResponse: rewritten.rawResponse,
                  expandedPrompt: rewritten.value.rewrittenPrompt,
                  optimizationSummary: rewritten.value.optimizationSummary,
                },
              );
            }
            plans.push(plan);
          } catch (error) {
            // A failed rewrite is represented as failed attempts for the whole
            // branch so other survivor branches can continue independently.
            for (
              let candidateIndex = 0;
              candidateIndex < payload.variantsPerRevision;
              candidateIndex += 1
            ) {
              const attemptId = attemptIdFor(
                job.id,
                localRound,
                branchIndex,
                candidateIndex,
              );
              await beginAttempt(database, {
                id: attemptId,
                jobId: job.id,
                localRound,
                branchIndex,
                candidateIndex,
                parentImageId: source.id,
                prompt: source.generationPrompt,
              });
              await failAttempt(database, attemptId, error);
              processedCandidates += 1;
            }
            await reporter.event(
              "error",
              "PROMPT_REWRITE_FAILED",
              `Prompt rewrite failed for round ${localRound}, branch ${branchIndex}`,
              { error: errorMessage(error), sourceImageId: source.id },
            );
          }
        }
      }

      const candidateTasks = plans.flatMap((plan) =>
        Array.from(
          { length: payload.variantsPerRevision },
          (_, candidateIndex) => ({ plan, candidateIndex }),
        ),
      );
      const draftResults = await mapWithConcurrency(
        candidateTasks,
        candidateConcurrency,
        async ({ plan, candidateIndex }) => {
          const attemptId = attemptIdFor(
            job.id,
            localRound,
            plan.branchIndex,
            candidateIndex,
          );
          try {
            const draft = await prepareCandidate(
              database,
              adapter,
              job.projectId,
              job.id,
              payloadSha256,
              payload.originalPrompt,
              plan,
              candidateIndex,
              payload.variantsPerRevision,
              references,
              storage,
            );
            preparedButNotFinalized.push(draft);
            return draft;
          } catch (error) {
            const outputPath = path.join(
              storage.images,
              `${imageIdFor(job.id, localRound, plan.branchIndex, candidateIndex)}.png`,
            );
            await failAttempt(
              database,
              attemptId,
              error,
              (await fileExists(outputPath))
                ? toProjectRelativePath(job.projectId, outputPath)
                : undefined,
            );
            await reporter.event(
              "error",
              "CANDIDATE_FAILED",
              `Candidate ${candidateIndex + 1} failed in round ${localRound}, branch ${plan.branchIndex}`,
              { error: errorMessage(error), attemptId },
            );
            return undefined;
          } finally {
            processedCandidates += 1;
            await reporter.progress(
              localRound,
              (processedCandidates / expectedCandidates) * 99,
            );
          }
        },
      );
      const drafts = draftResults.filter(
        (draft): draft is CandidateDraft => draft !== undefined,
      );

      if (drafts.length === 0) {
        throw new Error(`All candidates failed in round ${localRound}`);
      }
      const survivors = selectedCandidates(
        drafts.map((draft) => ({
          id: draft.imageId,
          revisionId: draft.plan.revisionId,
          revisionRound: draft.plan.graphRound,
          absolutePath: draft.absolutePath,
          generationPrompt: draft.candidatePrompt,
          evaluation: draft.evaluation.value,
          score: draft.evaluation.value.score,
        })),
        payload.survivorsPerRound,
      );
      const selectedIds = new Set(survivors.map(({ id }) => id));
      const finalized = await finalizeRound(database, {
        jobId: job.id,
        projectId: job.projectId,
        payload,
        plans,
        drafts,
        references,
        selectedIds,
        jobLogPath,
      });
      const finalizedAttemptIds = new Set(
        drafts.map(({ attemptId }) => attemptId),
      );
      preparedButNotFinalized = preparedButNotFinalized.filter(
        ({ attemptId }) => !finalizedAttemptIds.has(attemptId),
      );
      frontier = selectedCandidates(
        finalized.candidates,
        payload.survivorsPerRound,
      );
      allRevisionIds.push(...finalized.revisionIds);
      allImageIds.push(...finalized.candidates.map(({ id }) => id));
      await reporter.event(
        "info",
        "ROUND_COMPLETED",
        `Round ${localRound} completed`,
        {
          generated: finalized.candidates.length,
          selectedImageIds: frontier.map(({ id }) => id),
        },
      );
    }

    await reporter.event("info", "JOB_OUTPUT_READY", "All rounds finalized", {
      revisionIds: allRevisionIds,
      imageCount: allImageIds.length,
    });
    await rm(path.join(storage.work, job.id), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    return { revisionIds: allRevisionIds, imageIds: allImageIds };
  } catch (error) {
    // Includes failures outside finalization itself (for example progress or
    // event persistence). Only catalog-absent drafts are removed.
    await cleanRolledBackDrafts(database, preparedButNotFinalized, error);
    throw error;
  } finally {
    reporter.close();
  }
}
