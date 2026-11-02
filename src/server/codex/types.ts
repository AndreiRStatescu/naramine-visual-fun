import type {
  EvaluationResult,
  ExpandedPromptResult,
  RewritePromptResult,
} from "@/lib/contracts";

export type AdapterResponse<T> = {
  value: T;
  /** The complete instruction sent to Codex (or emulated by the fake). */
  prompt: string;
  /** The unmodified structured response, retained for inspection. */
  rawResponse: string;
};

export type ExpandPromptInput = {
  originalPrompt: string;
  editPrompt?: string;
  parentImagePath?: string;
  referenceImagePaths?: string[];
};

export type GenerateImagesInput = {
  expandedPrompt: string;
  outputPaths: string[];
  /** Stable per-candidate keys make the fake adapter reproducible. */
  candidateKeys: string[];
  /** Zero-based slot within the revision batch. */
  candidateIndex: number;
  /** Total candidates requested for this revision batch. */
  candidateCount: number;
  parentImagePath?: string;
  referenceImagePaths?: string[];
};

export type GeneratedImageResult = {
  path: string;
  /** The exact candidate-specific prompt Codex gave to imagegen. */
  finalPrompt: string;
  generationMetadata: Record<string, unknown>;
};

export type GenerateImagesResult = AdapterResponse<{
  images: GeneratedImageResult[];
}>;

export type EvaluateImageInput = {
  originalPrompt: string;
  imagePath: string;
};

export type RewritePromptInput = {
  originalPrompt: string;
  currentPrompt: string;
  imagePath: string;
  evaluation: EvaluationResult;
  nextRound: number;
};

export interface CodexAdapter {
  expandPrompt(
    input: ExpandPromptInput,
  ): Promise<AdapterResponse<ExpandedPromptResult>>;
  generateImages(input: GenerateImagesInput): Promise<GenerateImagesResult>;
  evaluateImage(
    input: EvaluateImageInput,
  ): Promise<AdapterResponse<EvaluationResult>>;
  rewritePrompt(
    input: RewritePromptInput,
  ): Promise<AdapterResponse<RewritePromptResult>>;
  summarizeProjectTitle(
    originalPrompt: string,
  ): Promise<AdapterResponse<{ title: string }>>;
}
