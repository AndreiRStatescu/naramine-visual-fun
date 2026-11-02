"use client";

import { ErrorIcon, RefreshIcon, SparklesIcon } from "@/components/icons";
import type { JobRecord } from "@/components/project-types";

export function JobStatus({
  jobs,
  onRefresh,
}: {
  jobs: JobRecord[];
  onRefresh: () => void;
}) {
  const active = jobs.find(
    (job) => job.state === "RUNNING" || job.state === "QUEUED",
  );
  const failed = jobs.find((job) => job.state === "FAILED");
  const job = active ?? failed;
  if (!job) return null;

  const running = job.state === "RUNNING";
  const queued = job.state === "QUEUED";
  const progress = Math.max(0, Math.min(100, job.progress));
  const title =
    failed && !active
      ? "Generation stopped"
      : queued
        ? "Exploration queued"
        : job.currentRound > 0 && job.totalRounds > 0
          ? `Exploring round ${job.currentRound} of ${job.totalRounds}`
          : "Generating your exploration";

  return (
    <div className={`job-status ${failed && !active ? "is-failed" : ""}`}>
      <div className="job-status-icon">
        {failed && !active ? (
          <ErrorIcon size={18} />
        ) : (
          <SparklesIcon size={17} />
        )}
      </div>
      <div className="job-status-copy">
        <div>
          <strong>{title}</strong>
          <span>
            {running
              ? `${progress}%`
              : queued
                ? "Waiting for worker"
                : "Needs attention"}
          </span>
        </div>
        {running ? (
          <div className="job-progress">
            <i style={{ width: `${Math.max(3, progress)}%` }} />
          </div>
        ) : null}
        {failed && !active && job.error ? <p>{job.error}</p> : null}
      </div>
      {failed && !active ? (
        <button
          aria-label="Refresh project"
          className="icon-button"
          onClick={onRefresh}
          type="button"
        >
          <RefreshIcon size={16} />
        </button>
      ) : (
        <span className="job-pulse" />
      )}
    </div>
  );
}
