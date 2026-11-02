import { randomUUID } from "node:crypto";

import type { Job } from "@prisma/client";
import pino, { type Logger } from "pino";

import { createCodexAdapter, type CodexAdapter } from "@/server/codex";
import { db as defaultDb, ensureDatabaseReady } from "@/server/db";
import { runOptimizationJob } from "@/server/orchestration";

type Database = typeof defaultDb;

export type WorkerOptions = {
  db?: Database;
  adapter?: CodexAdapter;
  pollMs?: number;
  staleAfterMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
  logger?: Logger;
  candidateConcurrency?: number;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function errorMessage(error: unknown): string {
  const message =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  return message.slice(0, 20_000);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Claim with compare-and-swap semantics so multiple processes cannot run a job. */
export async function claimNextJob(
  database: Database = defaultDb,
): Promise<Job | undefined> {
  // SQLite has no SKIP LOCKED. The conditional update is the atomic claim;
  // losing workers simply retry another queue iteration.
  for (
    let contentionAttempt = 0;
    contentionAttempt < 8;
    contentionAttempt += 1
  ) {
    const candidate = await database.job.findFirst({
      where: { state: "QUEUED" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    if (!candidate) return undefined;

    const now = new Date();
    const claimed = await database.job.updateMany({
      where: { id: candidate.id, state: "QUEUED" },
      data: {
        state: "RUNNING",
        lockedAt: now,
        startedAt: now,
        completedAt: null,
        error: null,
        attemptCount: { increment: 1 },
      },
    });
    if (claimed.count === 1) {
      return (
        (await database.job.findUnique({ where: { id: candidate.id } })) ??
        undefined
      );
    }
  }
  return undefined;
}

/** Return abandoned RUNNING work to the durable SQLite queue. */
export async function recoverStaleJobs(
  database: Database = defaultDb,
  staleAfterMs = positiveInteger(process.env.WORKER_STALE_MS, 15 * 60_000),
): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const staleJobs = await database.job.findMany({
    where: { state: "RUNNING", lockedAt: { lt: cutoff } },
    select: { id: true },
  });
  let recovered = 0;
  for (const stale of staleJobs) {
    const didRecover = await database.$transaction(async (transaction) => {
      const updated = await transaction.job.updateMany({
        where: {
          id: stale.id,
          state: "RUNNING",
          lockedAt: { lt: cutoff },
        },
        data: {
          state: "QUEUED",
          lockedAt: null,
          startedAt: null,
          error: null,
        },
      });
      if (updated.count !== 1) return false;
      await transaction.jobEvent.create({
        data: {
          id: randomUUID(),
          jobId: stale.id,
          level: "WARN",
          kind: "STALE_JOB_RECOVERED",
          message: "Returned an abandoned running job to the queue",
          dataJson: JSON.stringify({ cutoff: cutoff.toISOString() }),
        },
      });
      return true;
    });
    if (didRecover) recovered += 1;
  }
  return recovered;
}

async function completeJob(database: Database, jobId: string): Promise<void> {
  await database.$transaction(async (transaction) => {
    const completed = await transaction.job.updateMany({
      where: { id: jobId, state: "RUNNING" },
      data: {
        state: "COMPLETED",
        progress: 100,
        lockedAt: null,
        completedAt: new Date(),
        error: null,
      },
    });
    if (completed.count === 1) {
      await transaction.jobEvent.create({
        data: {
          id: randomUUID(),
          jobId,
          level: "INFO",
          kind: "JOB_COMPLETED",
          message: "Optimization job completed",
        },
      });
    }
  });
}

async function failJob(
  database: Database,
  jobId: string,
  error: unknown,
): Promise<void> {
  const message = errorMessage(error);
  await database.$transaction(async (transaction) => {
    const failed = await transaction.job.updateMany({
      where: { id: jobId, state: "RUNNING" },
      data: {
        state: "FAILED",
        lockedAt: null,
        completedAt: new Date(),
        error: message,
      },
    });
    if (failed.count === 1) {
      await transaction.jobEvent.create({
        data: {
          id: randomUUID(),
          jobId,
          level: "ERROR",
          kind: "JOB_FAILED",
          message: "Optimization job failed",
          dataJson: JSON.stringify({ error: message }),
        },
      });
    }
  });
}

export async function runWorker(options: WorkerOptions = {}): Promise<void> {
  const database = options.db ?? defaultDb;
  const adapter = options.adapter ?? createCodexAdapter();
  const pollMs =
    options.pollMs ?? positiveInteger(process.env.WORKER_POLL_MS, 1_500);
  const staleAfterMs =
    options.staleAfterMs ??
    positiveInteger(process.env.WORKER_STALE_MS, 15 * 60_000);
  const heartbeatMs =
    options.heartbeatMs ??
    positiveInteger(
      process.env.WORKER_HEARTBEAT_MS,
      Math.min(30_000, Math.max(1_000, Math.floor(staleAfterMs / 3))),
    );
  const signal = options.signal;
  const logger = options.logger ?? pino({ name: "ievcs-worker" });

  await ensureDatabaseReady();
  const recovered = await recoverStaleJobs(database, staleAfterMs);
  if (recovered > 0) logger.warn({ recovered }, "Recovered stale jobs");
  logger.info(
    { adapter: process.env.CODEX_ADAPTER ?? "fake" },
    "Worker started",
  );

  while (!signal?.aborted) {
    const job = await claimNextJob(database);
    if (!job) {
      await recoverStaleJobs(database, staleAfterMs);
      await delay(pollMs, signal);
      continue;
    }

    logger.info({ jobId: job.id, type: job.type }, "Claimed job");
    const heartbeat = setInterval(() => {
      void database.job
        .updateMany({
          where: { id: job.id, state: "RUNNING" },
          data: { lockedAt: new Date() },
        })
        .catch((error) =>
          logger.warn(
            { jobId: job.id, error: errorMessage(error) },
            "Job heartbeat failed",
          ),
        );
    }, heartbeatMs);
    heartbeat.unref();

    try {
      await runOptimizationJob(job.id, {
        db: database,
        adapter,
        candidateConcurrency: options.candidateConcurrency,
      });
      await completeJob(database, job.id);
      logger.info({ jobId: job.id }, "Completed job");
    } catch (error) {
      await failJob(database, job.id, error);
      logger.error({ jobId: job.id, error: errorMessage(error) }, "Job failed");
    } finally {
      clearInterval(heartbeat);
    }
  }

  logger.info("Worker stopped");
}
