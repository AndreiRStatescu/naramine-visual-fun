import { createHash } from "node:crypto";

function deterministicId(
  prefix: string,
  parts: Array<string | number>,
): string {
  const hash = createHash("sha256");
  hash.update(parts.map(String).join("\u0000"));
  return `${prefix}_${hash.digest("hex").slice(0, 32)}`;
}

export function revisionIdFor(
  jobId: string,
  localRound: number,
  branchIndex: number,
): string {
  return deterministicId("rev", [jobId, localRound, branchIndex]);
}

export function imageIdFor(
  jobId: string,
  localRound: number,
  branchIndex: number,
  candidateIndex: number,
): string {
  return deterministicId("img", [
    jobId,
    localRound,
    branchIndex,
    candidateIndex,
  ]);
}

export function attemptIdFor(
  jobId: string,
  localRound: number,
  branchIndex: number,
  candidateIndex: number,
): string {
  return deterministicId("attempt", [
    jobId,
    localRound,
    branchIndex,
    candidateIndex,
  ]);
}

export function evaluationIdFor(imageId: string): string {
  return deterministicId("evaluation", [imageId]);
}

export function edgeIdFor(imageId: string): string {
  return deterministicId("edge", [imageId]);
}
