export const DEFAULT_VARIANTS_PER_REVISION = 4;
export const DEFAULT_OPTIMIZATION_ROUNDS = 3;
export const DEFAULT_SURVIVORS_PER_ROUND = 2;

export const JOB_STATE = {
  queued: "QUEUED",
  running: "RUNNING",
  completed: "COMPLETED",
  failed: "FAILED",
} as const;

export type RankedCandidate<T> = {
  value: T;
  score: number;
  stableId: string;
};

/** Rank by score, then a stable identifier so orchestration is reproducible. */
export function selectSurvivors<T>(
  candidates: RankedCandidate<T>[],
  survivorCount: number,
): RankedCandidate<T>[] {
  return [...candidates]
    .sort((left, right) => {
      const scoreOrder = right.score - left.score;
      return scoreOrder === 0
        ? left.stableId.localeCompare(right.stableId)
        : scoreOrder;
    })
    .slice(0, Math.max(0, survivorCount));
}

/**
 * Round one has a single root batch. Every later round has one batch per
 * globally selected survivor from the preceding round.
 */
export function expectedImageCount(
  variantsPerRevision: number,
  rounds: number,
  survivorsPerRound: number,
): number {
  if (rounds <= 0 || variantsPerRevision <= 0) return 0;
  return (
    variantsPerRevision +
    Math.max(0, rounds - 1) * survivorsPerRound * variantsPerRevision
  );
}
