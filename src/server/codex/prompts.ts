import type {
  EvaluateImageInput,
  ExpandPromptInput,
  GenerateImagesInput,
  RewritePromptInput,
} from "./types";

function lines(values: string[]): string {
  return values.map((value) => `- ${value}`).join("\n");
}

const VARIATION_FOCUSES = [
  "composition and framing",
  "viewpoint, pose, and silhouette",
  "lighting, color, and atmosphere",
  "secondary design details and environment",
] as const;

export function buildExpandPrompt(input: ExpandPromptInput): string {
  const references = input.referenceImagePaths ?? [];
  return [
    "Act as an image-generation prompt planner.",
    "Expand the user's request into one precise, production-ready prompt for GPT Image.",
    "Preserve the user's intent. Do not introduce unrelated subject matter.",
    input.parentImagePath
      ? "The first attached image is the parent image to continue from."
      : "There is no parent image; plan a new composition.",
    references.length > 0
      ? `The final ${references.length} attached image(s) are immutable visual references.`
      : "There are no visual references.",
    `Original project prompt:\n${input.originalPrompt}`,
    input.editPrompt ? `Requested edit:\n${input.editPrompt}` : "",
    "Return only the requested structured result. The expanded prompt must stand alone.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildGeneratePrompt(input: GenerateImagesInput): string {
  const variationFocus =
    VARIATION_FOCUSES[input.candidateIndex % VARIATION_FOCUSES.length];
  const requested = input.outputPaths.map((outputPath, index) =>
    JSON.stringify({
      candidateKey: input.candidateKeys[index],
      outputPath,
    }),
  );
  return [
    "$imagegen",
    "Use the imagegen skill to create the requested PNG image files.",
    "Create a genuinely new image for every requested candidate. Do not merely copy an input image.",
    input.parentImagePath
      ? "The first attached image is the creative parent. Preserve it only where the prompt calls for continuity."
      : "There is no creative parent image.",
    (input.referenceImagePaths?.length ?? 0) > 0
      ? "Any remaining attached images are visual references."
      : "",
    `Shared revision prompt:\n${input.expandedPrompt}`,
    `This is variant ${input.candidateIndex + 1} of ${input.candidateCount} in the revision batch. Before calling imagegen, derive a slightly different final generation prompt for this variant. Preserve every hard subject and continuity constraint, but introduce a restrained, meaningful variation with emphasis on ${variationFocus}. Avoid duplicating the most obvious default interpretation of the shared prompt.`,
    `Required outputs:\n${lines(requested)}`,
    "Save each output at its exact absolute outputPath before responding.",
    "Do not modify any other file. Return only the requested structured result, including the exact finalPrompt used with imagegen and the exact paths created.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function buildEvaluationPrompt(input: EvaluateImageInput): string {
  return [
    "Evaluate the single attached generated image independently.",
    "Compare it only with the original project prompt below and the image itself.",
    "Do not infer or reward any later planning prompt, parent image, reference image, or other candidate.",
    "Use the entire 0-100 range. Return an integer score and concise, actionable feedback.",
    `Original project prompt:\n${input.originalPrompt}`,
    "Return only the requested structured result.",
  ].join("\n\n");
}

export function buildRewritePrompt(input: RewritePromptInput): string {
  return [
    "Rewrite an image-generation prompt for the next optimization round.",
    "The attached image is the selected survivor. Preserve its strengths and correct the evaluated weaknesses.",
    "Keep the result faithful to the original project prompt and avoid prompt drift.",
    `Original project prompt:\n${input.originalPrompt}`,
    `Current generation prompt:\n${input.currentPrompt}`,
    `Independent evaluation:\n${JSON.stringify(input.evaluation)}`,
    `The rewritten prompt will be used for optimization round ${input.nextRound}.`,
    "Return only the requested structured result.",
  ].join("\n\n");
}

export function buildTitlePrompt(originalPrompt: string): string {
  return [
    "Create a short, concrete project title for this image exploration.",
    "Use at most six words. Do not use quotation marks or a trailing period.",
    `Original project prompt:\n${originalPrompt}`,
    "Return only the requested structured result.",
  ].join("\n\n");
}
