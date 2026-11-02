import { describe, expect, it } from "vitest";

import {
  createProjectSchema,
  evaluationResultSchema,
  exploreSchema,
  jobPayloadSchema,
} from "@/lib/contracts";

describe("project contracts", () => {
  it("applies the product defaults", () => {
    const parsed = createProjectSchema.parse({
      originalPrompt: "A quiet cabin beneath the northern lights",
    });

    expect(parsed).toMatchObject({
      variantsPerRevision: 4,
      optimizationRounds: 3,
      survivorsPerRound: 2,
      referenceIds: [],
    });
  });

  it("rejects a survivor count larger than the revision batch", () => {
    const parsed = createProjectSchema.safeParse({
      originalPrompt: "A quiet cabin beneath the northern lights",
      variantsPerRevision: 1,
      survivorsPerRound: 2,
    });

    expect(parsed.success).toBe(false);
  });

  it("allows exploration without an explicit edit prompt", () => {
    expect(exploreSchema.parse({ sourceImageId: "image-1" })).toEqual({
      sourceImageId: "image-1",
      referenceIds: [],
    });
  });
});

describe("worker contracts", () => {
  it("requires a source image only for exploration jobs", () => {
    const base = {
      originalPrompt: "A quiet cabin",
      referenceIds: [],
      variantsPerRevision: 4,
      optimizationRounds: 3,
      survivorsPerRound: 2,
    };

    expect(
      jobPayloadSchema.safeParse({ ...base, mode: "INITIAL" }).success,
    ).toBe(true);
    expect(
      jobPayloadSchema.safeParse({ ...base, mode: "EXPLORE" }).success,
    ).toBe(false);
  });

  it("enforces the evaluation score range", () => {
    const result = evaluationResultSchema.safeParse({
      score: 101,
      strengths: [],
      weaknesses: [],
      recommendedImprovements: [],
      reasoning: "Too high",
    });

    expect(result.success).toBe(false);
  });
});
