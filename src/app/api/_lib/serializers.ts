import { parseJsonArray, safeJsonParse } from "@/lib/contracts";

type ReferenceRecord = {
  id: string;
  originalName: string;
  mimeType: string;
  sha256: string;
  width: number;
  height: number;
  createdAt: Date;
};

export function serializeReference(reference: ReferenceRecord) {
  return {
    id: reference.id,
    originalName: reference.originalName,
    mimeType: reference.mimeType,
    sha256: reference.sha256,
    width: reference.width,
    height: reference.height,
    createdAt: reference.createdAt,
    url: `/api/references/${encodeURIComponent(reference.id)}`,
  };
}

type JobEventRecord = {
  id: string;
  level: string;
  kind: string;
  message: string;
  dataJson: string | null;
  createdAt: Date;
};

type CandidateAttemptRecord = {
  id: string;
  round: number;
  branchIndex: number;
  candidateIndex: number;
  parentImageId: string | null;
  state: string;
  prompt: string;
  error: string | null;
  attemptCount: number;
  outputPath: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type JobRecord = {
  id: string;
  projectId: string;
  type: string;
  state: string;
  payloadJson: string;
  progress: number;
  currentRound: number;
  totalRounds: number;
  attemptCount: number;
  lockedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
  events?: JobEventRecord[];
  attempts?: CandidateAttemptRecord[];
};

export function serializeJob(job: JobRecord) {
  return {
    id: job.id,
    projectId: job.projectId,
    type: job.type,
    state: job.state,
    payload: safeJsonParse<Record<string, unknown>>(job.payloadJson, {}),
    progress: job.progress,
    currentRound: job.currentRound,
    totalRounds: job.totalRounds,
    attemptCount: job.attemptCount,
    lockedAt: job.lockedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.events
      ? {
          events: job.events.map((event) => ({
            id: event.id,
            level: event.level,
            kind: event.kind,
            message: event.message,
            data: event.dataJson
              ? safeJsonParse<unknown>(event.dataJson, null)
              : null,
            createdAt: event.createdAt,
          })),
        }
      : {}),
    ...(job.attempts
      ? {
          attempts: job.attempts.map((attempt) => ({
            id: attempt.id,
            round: attempt.round,
            branchIndex: attempt.branchIndex,
            candidateIndex: attempt.candidateIndex,
            parentImageId: attempt.parentImageId,
            state: attempt.state,
            prompt: attempt.prompt,
            error: attempt.error,
            attemptCount: attempt.attemptCount,
            outputPath: attempt.outputPath,
            createdAt: attempt.createdAt,
            updatedAt: attempt.updatedAt,
          })),
        }
      : {}),
  };
}

type EvaluationRecord = {
  score: number;
  strengthsJson: string;
  weaknessesJson: string;
  recommendationsJson: string;
  reasoning: string;
  evaluatorPrompt: string;
  evaluatorResponse: string;
  createdAt: Date;
};

export function serializeEvaluation(evaluation: EvaluationRecord | null) {
  if (!evaluation) return null;
  return {
    score: evaluation.score,
    strengths: parseJsonArray(evaluation.strengthsJson),
    weaknesses: parseJsonArray(evaluation.weaknessesJson),
    recommendedImprovements: parseJsonArray(evaluation.recommendationsJson),
    reasoning: evaluation.reasoning,
    evaluatorPrompt: evaluation.evaluatorPrompt,
    evaluatorResponse: evaluation.evaluatorResponse,
    createdAt: evaluation.createdAt,
  };
}
