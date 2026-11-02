import { describe, expect, it } from "vitest";

import { normalizeProjectDetail } from "./project-types";

const project = {
  id: "project-1",
  title: "Test exploration",
  originalPrompt: "A quiet landscape",
  variantsPerRevision: 4,
  optimizationRounds: 3,
  survivorsPerRound: 2,
};

describe("normalizeProjectDetail transient images", () => {
  it("preserves provisional attempt state without inventing an image asset", () => {
    const detail = normalizeProjectDetail({
      project,
      graph: {
        nodes: [
          {
            id: "deterministic-image-1",
            revisionId: "revision-1",
            candidateIndex: 2,
            status: "FAILED",
            provisional: true,
            error: "Generator exited before writing an image",
            revision: {
              id: "revision-1",
              round: 2,
              branchIndex: 0,
              originalPrompt: project.originalPrompt,
              expandedPrompt: "A planned prompt",
              references: [],
            },
          },
        ],
        edges: [],
      },
      revisions: [],
      references: [],
      jobs: [],
    });

    expect(detail.images[0]).toMatchObject({
      id: "deterministic-image-1",
      provisional: true,
      status: "FAILED",
      error: "Generator exited before writing an image",
      round: 2,
      originalUrl: undefined,
      thumbnailUrl: undefined,
    });
  });

  it("recognizes the finalized form of the same deterministic image id", () => {
    const detail = normalizeProjectDetail({
      project,
      graph: {
        nodes: [
          {
            id: "deterministic-image-1",
            revisionId: "revision-1",
            candidateIndex: 2,
            status: "COMPLETED",
            originalUrl: "/api/images/deterministic-image-1",
            thumbnailUrl: "/api/images/deterministic-image-1?thumbnail=1",
            position: null,
          },
        ],
        edges: [],
      },
      revisions: [],
      references: [],
      jobs: [],
    });

    expect(detail.images[0]).toMatchObject({
      id: "deterministic-image-1",
      provisional: false,
      status: "COMPLETED",
      originalUrl: "/api/images/deterministic-image-1",
      position: null,
    });
  });

  it("preserves URLs for generated provisional images", () => {
    const detail = normalizeProjectDetail({
      project,
      graph: {
        nodes: [
          {
            id: "deterministic-image-2",
            revisionId: "revision-1",
            candidateIndex: 0,
            status: "EVALUATING",
            provisional: true,
            originalUrl: "/api/images/deterministic-image-2",
            thumbnailUrl: "/api/images/deterministic-image-2?thumbnail=1",
          },
        ],
        edges: [],
      },
      revisions: [],
      references: [],
      jobs: [],
    });

    expect(detail.images[0]).toMatchObject({
      provisional: true,
      status: "EVALUATING",
      originalUrl: "/api/images/deterministic-image-2",
      thumbnailUrl: "/api/images/deterministic-image-2?thumbnail=1",
    });
  });
});
