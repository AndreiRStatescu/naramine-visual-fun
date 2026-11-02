import { describe, expect, it } from "vitest";

import {
  buildProvisionalGraph,
  queuedFirstRoundAttempts,
} from "./provisional-graph";
import {
  attemptIdFor,
  edgeIdFor,
  imageIdFor,
  revisionIdFor,
} from "@/server/orchestration/ids";

const now = new Date("2026-08-03T10:00:00.000Z");

function attempt(
  jobId: string,
  candidateIndex: number,
  overrides: Partial<{
    round: number;
    branchIndex: number;
    parentImageId: string | null;
    state: string;
    prompt: string;
    error: string | null;
    outputPath: string | null;
  }> = {},
) {
  const round = overrides.round ?? 1;
  const branchIndex = overrides.branchIndex ?? 0;
  return {
    id: `attempt-${jobId}-${round}-${branchIndex}-${candidateIndex}`,
    round,
    branchIndex,
    candidateIndex,
    parentImageId: overrides.parentImageId ?? null,
    state: overrides.state ?? "QUEUED",
    prompt: overrides.prompt ?? "Expanded image prompt",
    error: overrides.error ?? null,
    attemptCount: 0,
    outputPath: overrides.outputPath ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("provisional graph projection", () => {
  it("pre-creates deterministic queued attempts for the knowable first batch", () => {
    const attempts = queuedFirstRoundAttempts("job-root", 4, "Original prompt");

    expect(attempts).toHaveLength(4);
    expect(attempts[3]).toEqual({
      id: attemptIdFor("job-root", 1, 0, 3),
      round: 1,
      branchIndex: 0,
      candidateIndex: 3,
      parentImageId: undefined,
      state: "QUEUED",
      prompt: "Original prompt",
    });
    expect(new Set(attempts.map(({ id }) => id))).toHaveProperty("size", 4);
  });

  it("projects root attempts without pretending image assets exist", () => {
    const jobId = "job-initial";
    const reference = {
      id: "reference-1",
      originalName: "palette.png",
      mimeType: "image/png",
      sha256: "abc",
      width: 32,
      height: 32,
      createdAt: now,
    };
    const result = buildProvisionalGraph({
      projectPrompt: "Original prompt",
      images: [],
      edges: [],
      references: [reference],
      jobs: [
        {
          id: jobId,
          createdAt: now,
          payloadJson: JSON.stringify({
            mode: "INITIAL",
            originalPrompt: "Original prompt",
            referenceIds: [reference.id],
            variantsPerRevision: 2,
            optimizationRounds: 3,
            survivorsPerRound: 1,
          }),
          attempts: [attempt(jobId, 0), attempt(jobId, 1)],
        },
      ],
    });

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0]).toMatchObject({
      id: imageIdFor(jobId, 1, 0, 0),
      revisionId: revisionIdFor(jobId, 1, 0),
      status: "QUEUED",
      provisional: true,
      generationPrompt: "Expanded image prompt",
      revision: {
        round: 1,
        sourceImageId: null,
        provisional: true,
        references: [
          {
            referenceId: reference.id,
            ordinal: 0,
            reference: { url: `/api/references/${reference.id}` },
          },
        ],
      },
    });
    expect(result.nodes[0]).not.toHaveProperty("originalUrl");
    expect(result.nodes[0]).not.toHaveProperty("thumbnailUrl");
    expect(result.nodes[0]).not.toHaveProperty("width");
    expect(result.nodes[0]).not.toHaveProperty("evaluation");
    expect(result.edges).toEqual([]);
    expect(result.revisions).toHaveLength(1);
  });

  it("exposes a provisional artifact as soon as generation publishes it", () => {
    const jobId = "job-generated";
    const imageId = imageIdFor(jobId, 1, 0, 0);
    const result = buildProvisionalGraph({
      projectPrompt: "Original prompt",
      images: [],
      edges: [],
      references: [],
      jobs: [
        {
          id: jobId,
          createdAt: now,
          payloadJson: JSON.stringify({
            mode: "INITIAL",
            originalPrompt: "Original prompt",
            referenceIds: [],
            variantsPerRevision: 1,
            optimizationRounds: 1,
            survivorsPerRound: 1,
          }),
          attempts: [
            attempt(jobId, 0, {
              state: "EVALUATING",
              outputPath: `images/${imageId}.png`,
            }),
          ],
        },
      ],
    });

    expect(result.nodes[0]).toMatchObject({
      id: imageId,
      provisional: true,
      status: "EVALUATING",
      originalUrl: `/api/images/${imageId}`,
      thumbnailUrl: `/api/images/${imageId}?thumbnail=1`,
    });
  });

  it("keeps failed attempts, derives parent graph depth, and skips finalized nodes", () => {
    const jobId = "job-explore";
    const sourceImageId = "source-image";
    const finalizedImageId = imageIdFor(jobId, 1, 0, 0);
    const failedImageId = imageIdFor(jobId, 1, 0, 1);
    const result = buildProvisionalGraph({
      projectPrompt: "Original prompt",
      images: [
        {
          id: sourceImageId,
          revisionId: "source-revision",
          revision: { round: 4 },
        },
        {
          id: finalizedImageId,
          revisionId: revisionIdFor(jobId, 1, 0),
          revision: { round: 5 },
        },
      ],
      edges: [
        {
          id: edgeIdFor(finalizedImageId),
          targetImageId: finalizedImageId,
        },
      ],
      references: [],
      jobs: [
        {
          id: jobId,
          createdAt: now,
          payloadJson: JSON.stringify({
            mode: "EXPLORE",
            originalPrompt: "Original prompt",
            sourceImageId,
            editPrompt: "Warmer light",
            referenceIds: [],
            variantsPerRevision: 2,
            optimizationRounds: 1,
            survivorsPerRound: 1,
          }),
          attempts: [
            attempt(jobId, 0, {
              parentImageId: sourceImageId,
              state: "COMPLETED",
            }),
            attempt(jobId, 1, {
              parentImageId: sourceImageId,
              state: "FAILED",
              error: "generator exited",
            }),
          ],
        },
      ],
    });

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      id: failedImageId,
      status: "FAILED",
      error: "generator exited",
      revision: {
        parentRevisionId: "source-revision",
        sourceImageId,
        round: 5,
        editPrompt: "Warmer light",
      },
    });
    expect(result.edges).toEqual([
      expect.objectContaining({
        id: edgeIdFor(failedImageId),
        source: sourceImageId,
        target: failedImageId,
        metadata: expect.objectContaining({
          provisional: true,
          jobId,
          state: "FAILED",
        }),
      }),
    ]);
  });
});
