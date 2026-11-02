import { createHash, randomUUID } from "node:crypto";
import { access, link, mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import {
  buildEvaluationPrompt,
  buildExpandPrompt,
  buildGeneratePrompt,
  buildRewritePrompt,
  buildTitlePrompt,
} from "./prompts";
import type {
  AdapterResponse,
  CodexAdapter,
  EvaluateImageInput,
  ExpandPromptInput,
  GenerateImagesInput,
  GenerateImagesResult,
  RewritePromptInput,
} from "./types";

function response<T>(value: T, prompt: string): AdapterResponse<T> {
  return { value, prompt, rawResponse: JSON.stringify(value) };
}

function digest(value: string | Buffer): Buffer {
  return createHash("sha256").update(value).digest();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function createFakePng(outputPath: string, key: string): Promise<void> {
  if (await pathExists(outputPath)) {
    throw new Error(`Refusing to overwrite existing image: ${outputPath}`);
  }

  const hash = digest(key);
  const background = {
    r: 40 + (hash[0] % 176),
    g: 40 + (hash[1] % 176),
    b: 40 + (hash[2] % 176),
    alpha: 1,
  };
  const accent = `rgb(${hash[3]},${hash[4]},${hash[5]})`;
  const x = 80 + (hash[6] % 260);
  const y = 80 + (hash[7] % 260);
  const radius = 48 + (hash[8] % 92);
  const mark = hash.toString("hex").slice(0, 10).toUpperCase();
  const svg = Buffer.from(
    `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">` +
      `<circle cx="${x}" cy="${y}" r="${radius}" fill="${accent}" opacity=".82"/>` +
      `<path d="M40 430 Q256 ${120 + (hash[9] % 180)} 472 430" fill="none" stroke="white" stroke-width="18" opacity=".7"/>` +
      `<text x="40" y="478" fill="white" opacity=".86" font-family="sans-serif" font-size="24">${mark}</text>` +
      `</svg>`,
  );

  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await sharp({ create: { width: 512, height: 512, channels: 4, background } })
    .composite([{ input: svg }])
    .png()
    .toFile(temporaryPath);

  try {
    // A hard link gives us O_EXCL semantics: concurrent work cannot overwrite.
    await link(temporaryPath, outputPath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

export class FakeCodexAdapter implements CodexAdapter {
  async expandPrompt(input: ExpandPromptInput) {
    const prompt = buildExpandPrompt(input);
    const parts = [
      input.originalPrompt.trim(),
      input.editPrompt?.trim(),
      "Create a cohesive composition with intentional lighting, clear visual hierarchy, and carefully resolved details.",
    ].filter(Boolean);
    return response(
      {
        expandedPrompt: parts.join(" "),
        planningSummary:
          "Preserved the requested subject while making composition, lighting, and finish explicit.",
      },
      prompt,
    );
  }

  async generateImages(
    input: GenerateImagesInput,
  ): Promise<GenerateImagesResult> {
    if (
      input.outputPaths.length === 0 ||
      input.outputPaths.length !== input.candidateKeys.length
    ) {
      throw new Error(
        "Every generated output requires one stable candidate key",
      );
    }

    const prompt = buildGeneratePrompt(input);
    const images = [];
    for (let index = 0; index < input.outputPaths.length; index += 1) {
      const outputPath = input.outputPaths[index];
      const candidateKey = input.candidateKeys[index];
      const finalPrompt = `${input.expandedPrompt} Explore a distinct but faithful interpretation for variant ${input.candidateIndex + 1} of ${input.candidateCount}.`;
      await createFakePng(outputPath, `${finalPrompt}\u0000${candidateKey}`);
      images.push({
        path: outputPath,
        finalPrompt,
        generationMetadata: {
          adapter: "fake",
          candidateKey,
          deterministic: true,
          width: 512,
          height: 512,
        },
      });
    }
    return response({ images }, prompt);
  }

  async evaluateImage(input: EvaluateImageInput) {
    const prompt = buildEvaluationPrompt(input);
    const bytes = await readFile(input.imagePath);
    const hash = digest(
      Buffer.concat([
        Buffer.from(input.originalPrompt),
        Buffer.from([0]),
        bytes,
      ]),
    );
    const score = hash.readUInt16BE(0) % 101;
    return response(
      {
        score,
        strengths: ["The image has a clear focal structure."],
        weaknesses: ["Some secondary details could be more intentional."],
        recommendedImprovements: [
          "Refine secondary forms while preserving the main composition.",
        ],
        reasoning: `Deterministic fake evaluation (${score}/100) for local development.`,
      },
      prompt,
    );
  }

  async rewritePrompt(input: RewritePromptInput) {
    const prompt = buildRewritePrompt(input);
    const improvement =
      input.evaluation.recommendedImprovements[0] ??
      "Improve fidelity and fine detail.";
    return response(
      {
        rewrittenPrompt: `${input.currentPrompt} ${improvement}`,
        optimizationSummary: `Round ${input.nextRound}: ${improvement}`,
      },
      prompt,
    );
  }

  async summarizeProjectTitle(originalPrompt: string) {
    const prompt = buildTitlePrompt(originalPrompt);
    const words = originalPrompt
      .trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6);
    const title = words.length > 0 ? words.join(" ") : "Untitled Exploration";
    return response({ title }, prompt);
  }
}
