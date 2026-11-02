import { jobPayloadSchema } from "@/lib/contracts";
import {
  attemptIdFor,
  edgeIdFor,
  imageIdFor,
  revisionIdFor,
} from "@/server/orchestration/ids";

import { serializeReference } from "./serializers";

type ExistingImage = {
  id: string;
  revisionId: string;
  revision: { round: number };
};

type ExistingEdge = {
  id: string;
  targetImageId: string;
};

type ReferenceRecord = Parameters<typeof serializeReference>[0];

type AttemptRecord = {
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
  payloadJson: string;
  createdAt: Date;
  attempts: AttemptRecord[];
};

export function queuedFirstRoundAttempts(
  jobId: string,
  variantsPerRevision: number,
  prompt: string,
  parentImageId?: string,
) {
  return Array.from({ length: variantsPerRevision }, (_, candidateIndex) => ({
    id: attemptIdFor(jobId, 1, 0, candidateIndex),
    round: 1,
    branchIndex: 0,
    candidateIndex,
    parentImageId,
    state: "QUEUED",
    prompt,
  }));
}

function shortLabel(value: string): string {
  return value.length <= 120 ? value : `${value.slice(0, 117)}...`;
}

export function buildProvisionalGraph(input: {
  projectPrompt: string;
  images: ExistingImage[];
  edges: ExistingEdge[];
  references: ReferenceRecord[];
  jobs: JobRecord[];
}) {
  const imagesById = new Map(input.images.map((image) => [image.id, image]));
  const referenceById = new Map(
    input.references.map((reference) => [reference.id, reference]),
  );
  const occupiedNodeIds = new Set(imagesById.keys());
  const occupiedEdgeIds = new Set(input.edges.map(({ id }) => id));
  const occupiedEdgeTargets = new Set(
    input.edges.map(({ targetImageId }) => targetImageId),
  );
  const nodes: Array<Record<string, unknown>> = [];
  const edges: Array<Record<string, unknown>> = [];
  const revisions = new Map<string, Record<string, unknown>>();

  // Project detail queries jobs newest-first. Render transient history in the
  // same chronological direction as immutable graph records.
  for (const job of [...input.jobs].reverse()) {
    const parsedPayload = jobPayloadSchema.safeParse(
      (() => {
        try {
          return JSON.parse(job.payloadJson) as unknown;
        } catch {
          return null;
        }
      })(),
    );
    if (!parsedPayload.success) continue;
    const payload = parsedPayload.data;

    for (const attempt of job.attempts) {
      const imageId = imageIdFor(
        job.id,
        attempt.round,
        attempt.branchIndex,
        attempt.candidateIndex,
      );
      // Finalization publishes all immutable DTOs at once. If an immutable
      // image already exists, it always wins over its mutable attempt record.
      if (occupiedNodeIds.has(imageId)) continue;
      occupiedNodeIds.add(imageId);

      const revisionId = revisionIdFor(
        job.id,
        attempt.round,
        attempt.branchIndex,
      );
      const parentImage = attempt.parentImageId
        ? imagesById.get(attempt.parentImageId)
        : undefined;
      const graphRound = parentImage
        ? parentImage.revision.round + 1
        : attempt.round;
      const editPrompt =
        attempt.round === 1 ? (payload.editPrompt ?? null) : null;
      const referenceLinks = payload.referenceIds.map(
        (referenceId, ordinal) => {
          const reference = referenceById.get(referenceId);
          return {
            referenceId,
            ordinal,
            role: "visual",
            ...(reference ? { reference: serializeReference(reference) } : {}),
          };
        },
      );
      const revision = {
        id: revisionId,
        parentRevisionId: parentImage?.revisionId ?? null,
        sourceImageId: attempt.parentImageId,
        round: graphRound,
        branchIndex: attempt.branchIndex,
        originalPrompt: payload.originalPrompt || input.projectPrompt,
        editPrompt,
        expandedPrompt: attempt.prompt,
        optimizationSummary: null,
        jobLogPath: null,
        createdAt: attempt.createdAt,
        references: referenceLinks,
        provisional: true,
        jobId: job.id,
        localRound: attempt.round,
      };
      revisions.set(revisionId, revisions.get(revisionId) ?? revision);
      const hasArtifact = Boolean(attempt.outputPath);
      const originalUrl = `/api/images/${encodeURIComponent(imageId)}`;
      const thumbnailUrl = `${originalUrl}?thumbnail=1`;

      nodes.push({
        id: imageId,
        revisionId,
        candidateIndex: attempt.candidateIndex,
        selected: false,
        status: attempt.state.toUpperCase(),
        generationPrompt: attempt.prompt,
        generationMeta: JSON.stringify({
          provisional: true,
          attemptId: attempt.id,
          jobId: job.id,
          localRound: attempt.round,
          state: attempt.state,
          error: attempt.error,
        }),
        createdAt: attempt.createdAt,
        position: null,
        revision,
        provisional: true,
        attemptId: attempt.id,
        jobId: job.id,
        localRound: attempt.round,
        branchIndex: attempt.branchIndex,
        error: attempt.error,
        attemptCount: attempt.attemptCount,
        updatedAt: attempt.updatedAt,
        ...(hasArtifact ? { originalUrl, thumbnailUrl } : {}),
      });

      if (!attempt.parentImageId) continue;
      const edgeId = edgeIdFor(imageId);
      if (occupiedEdgeIds.has(edgeId) || occupiedEdgeTargets.has(imageId)) {
        continue;
      }
      occupiedEdgeIds.add(edgeId);
      occupiedEdgeTargets.add(imageId);
      const label = shortLabel(
        editPrompt ||
          (attempt.round === 1
            ? "Generating variations"
            : `Optimization round ${attempt.round}`),
      );
      edges.push({
        id: edgeId,
        source: attempt.parentImageId,
        target: imageId,
        label,
        metadata: {
          provisional: true,
          jobId: job.id,
          attemptId: attempt.id,
          localRound: attempt.round,
          state: attempt.state,
          editPrompt,
          generationPrompt: attempt.prompt,
          referenceIds: payload.referenceIds,
          error: attempt.error,
        },
        revisionId,
        createdAt: attempt.createdAt,
      });
    }
  }

  return { nodes, edges, revisions: [...revisions.values()] };
}
