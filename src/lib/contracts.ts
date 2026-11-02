import { z } from "zod";

export const JOB_STATES = ["QUEUED", "RUNNING", "COMPLETED", "FAILED"] as const;

export const JOB_TYPES = ["OPTIMIZE", "EXPLORE"] as const;

export const createProjectSchema = z
  .object({
    originalPrompt: z.string().trim().min(3).max(8_000),
    title: z.string().trim().min(1).max(100).optional(),
    variantsPerRevision: z.coerce.number().int().min(1).max(8).default(4),
    optimizationRounds: z.coerce.number().int().min(1).max(6).default(3),
    survivorsPerRound: z.coerce.number().int().min(1).max(4).default(2),
    referenceIds: z.array(z.string().min(1)).max(2).default([]),
  })
  .refine((value) => value.survivorsPerRound <= value.variantsPerRevision, {
    message: "Survivors cannot exceed variants per revision",
    path: ["survivorsPerRound"],
  });

export const exploreSchema = z.object({
  sourceImageId: z.string().min(1),
  editPrompt: z.string().trim().max(8_000).optional(),
  referenceIds: z.array(z.string().min(1)).max(2).default([]),
  variantsPerRevision: z.coerce.number().int().min(1).max(8).optional(),
  optimizationRounds: z.coerce.number().int().min(1).max(6).optional(),
  survivorsPerRound: z.coerce.number().int().min(1).max(4).optional(),
});

export const canvasPositionsSchema = z.object({
  positions: z
    .array(
      z.object({
        imageId: z.string().min(1),
        x: z.number().finite(),
        y: z.number().finite(),
      }),
    )
    .min(1)
    .max(2_000),
});

export const jobPayloadSchema = z
  .object({
    mode: z.enum(["INITIAL", "EXPLORE"]),
    originalPrompt: z.string().min(1),
    sourceImageId: z.string().min(1).optional(),
    editPrompt: z.string().max(8_000).optional(),
    referenceIds: z.array(z.string().min(1)).max(2).default([]),
    variantsPerRevision: z.number().int().min(1).max(8),
    optimizationRounds: z.number().int().min(1).max(6),
    survivorsPerRound: z.number().int().min(1).max(4),
  })
  .refine(
    (value) => value.mode === "INITIAL" || Boolean(value.sourceImageId),
    "Explore jobs require a source image",
  );

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type ExploreInput = z.infer<typeof exploreSchema>;
export type JobPayload = z.infer<typeof jobPayloadSchema>;

export const evaluationResultSchema = z.object({
  score: z.number().int().min(0).max(100),
  strengths: z.array(z.string()).max(8),
  weaknesses: z.array(z.string()).max(8),
  recommendedImprovements: z.array(z.string()).max(8),
  reasoning: z.string().min(1).max(2_000),
});

export const expandedPromptResultSchema = z.object({
  expandedPrompt: z.string().min(1).max(12_000),
  planningSummary: z.string().min(1).max(2_000),
});

export const rewritePromptResultSchema = z.object({
  rewrittenPrompt: z.string().min(1).max(12_000),
  optimizationSummary: z.string().min(1).max(2_000),
});

export const projectTitleResultSchema = z.object({
  title: z.string().trim().min(1).max(100),
});

export type EvaluationResult = z.infer<typeof evaluationResultSchema>;
export type ExpandedPromptResult = z.infer<typeof expandedPromptResultSchema>;
export type RewritePromptResult = z.infer<typeof rewritePromptResultSchema>;

export function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

export function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
