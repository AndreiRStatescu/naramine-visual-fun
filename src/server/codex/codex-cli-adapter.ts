import { spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import type { ZodType } from "zod";

import {
  evaluationResultSchema,
  expandedPromptResultSchema,
  projectTitleResultSchema,
  rewritePromptResultSchema,
} from "@/lib/contracts";

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
  GeneratedImageResult,
  RewritePromptInput,
} from "./types";

const MAX_CAPTURE_BYTES = 1_000_000;

const STRING_ARRAY_SCHEMA = {
  type: "array",
  items: { type: "string" },
  maxItems: 8,
} as const;

const EXPANDED_PROMPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["expandedPrompt", "planningSummary"],
  properties: {
    expandedPrompt: { type: "string" },
    planningSummary: { type: "string" },
  },
} as const;

const EVALUATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "score",
    "strengths",
    "weaknesses",
    "recommendedImprovements",
    "reasoning",
  ],
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    strengths: STRING_ARRAY_SCHEMA,
    weaknesses: STRING_ARRAY_SCHEMA,
    recommendedImprovements: STRING_ARRAY_SCHEMA,
    reasoning: { type: "string" },
  },
} as const;

const REWRITE_PROMPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rewrittenPrompt", "optimizationSummary"],
  properties: {
    rewrittenPrompt: { type: "string" },
    optimizationSummary: { type: "string" },
  },
} as const;

const TITLE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title"],
  properties: { title: { type: "string" } },
} as const;

type JsonSchema = Record<string, unknown>;

export type CodexCliAdapterOptions = {
  binary?: string;
  /** Parent directory for isolated per-invocation workspaces. */
  cwd?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
};

export class CodexInvocationError extends Error {
  constructor(
    message: string,
    readonly details: {
      exitCode: number | null;
      signal: NodeJS.Signals | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    },
  ) {
    super(message);
    this.name = "CodexInvocationError";
  }
}

export class MissingGeneratedImagesError extends Error {
  constructor(readonly missingPaths: string[]) {
    super(`Codex did not create valid images at: ${missingPaths.join(", ")}`);
    this.name = "MissingGeneratedImagesError";
  }
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function appendLimited(current: string, chunk: Buffer | string): string {
  if (current.length >= MAX_CAPTURE_BYTES) return current;
  return (current + chunk.toString()).slice(0, MAX_CAPTURE_BYTES);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function isValidImage(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    const metadata = await sharp(filePath).metadata();
    return Boolean(
      metadata.width && metadata.height && metadata.format === "png",
    );
  } catch {
    return false;
  }
}

export class CodexCliAdapter implements CodexAdapter {
  private readonly binary: string;
  private readonly isolationRoot: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;

  constructor(options: CodexCliAdapterOptions = {}) {
    this.binary = options.binary ?? process.env.CODEX_BIN ?? "codex";
    this.isolationRoot = path.resolve(options.cwd ?? tmpdir());
    this.timeoutMs =
      options.timeoutMs ??
      parsePositiveInteger(process.env.CODEX_TIMEOUT_MS, 10 * 60_000);
    this.maxRetries =
      options.maxRetries ??
      parseNonNegativeInteger(process.env.CODEX_RETRIES, 2);
    this.retryDelayMs = options.retryDelayMs ?? 300;
  }

  async expandPrompt(input: ExpandPromptInput) {
    const prompt = buildExpandPrompt(input);
    return this.invoke(
      prompt,
      EXPANDED_PROMPT_SCHEMA,
      expandedPromptResultSchema,
      [input.parentImagePath, ...(input.referenceImagePaths ?? [])].filter(
        (value): value is string => Boolean(value),
      ),
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

    const expectedPaths = input.outputPaths.map((filePath) =>
      path.resolve(filePath),
    );
    for (const outputPath of expectedPaths) {
      if (await isValidImage(outputPath)) {
        throw new Error(`Refusing to overwrite existing image: ${outputPath}`);
      }
    }

    let missingPaths = [...expectedPaths];
    const metadataByPath = new Map<string, Record<string, unknown>>();
    const promptByPath = new Map<string, string>();
    const responses: string[] = [];
    let lastPrompt = "";

    // A successful CLI response can still omit a requested file. Retry only the
    // missing candidates and preserve valid files from prior invocations.
    for (
      let imageAttempt = 0;
      imageAttempt <= this.maxRetries;
      imageAttempt += 1
    ) {
      const indexes = missingPaths.map((missingPath) =>
        expectedPaths.indexOf(missingPath),
      );
      const attemptInput: GenerateImagesInput = {
        ...input,
        outputPaths: indexes.map((index) => input.outputPaths[index]),
        candidateKeys: indexes.map((index) => input.candidateKeys[index]),
      };
      lastPrompt = buildGeneratePrompt(attemptInput);
      const generationSchema: JsonSchema = {
        type: "object",
        additionalProperties: false,
        required: ["images"],
        properties: {
          images: {
            type: "array",
            minItems: missingPaths.length,
            maxItems: missingPaths.length,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "finalPrompt", "generationMetadata"],
              properties: {
                path: { type: "string" },
                finalPrompt: {
                  type: "string",
                  minLength: 1,
                  maxLength: 12_000,
                },
                generationMetadata: {
                  type: "object",
                  additionalProperties: false,
                  required: ["notes"],
                  properties: {
                    notes: { type: "string" },
                  },
                },
              },
            },
          },
        },
      };
      const result = await this.invoke(
        lastPrompt,
        generationSchema,
        // The generated schema is validated structurally here and file validity
        // is checked separately below.
        {
          parse(value: unknown) {
            if (!value || typeof value !== "object") {
              throw new Error("Invalid generation response");
            }
            const images = (value as { images?: unknown }).images;
            if (!Array.isArray(images)) {
              throw new Error("Generation response did not contain images");
            }
            return {
              images: images.map((image) => {
                if (!image || typeof image !== "object") {
                  throw new Error("Invalid generated image response");
                }
                const candidate = image as {
                  path?: unknown;
                  finalPrompt?: unknown;
                  generationMetadata?: unknown;
                };
                if (typeof candidate.path !== "string") {
                  throw new Error("Generated image response omitted its path");
                }
                if (
                  typeof candidate.finalPrompt !== "string" ||
                  candidate.finalPrompt.trim().length === 0 ||
                  candidate.finalPrompt.length > 12_000
                ) {
                  throw new Error(
                    "Generated image response omitted its final prompt",
                  );
                }
                return {
                  path: candidate.path,
                  finalPrompt: candidate.finalPrompt,
                  generationMetadata:
                    candidate.generationMetadata &&
                    typeof candidate.generationMetadata === "object" &&
                    !Array.isArray(candidate.generationMetadata)
                      ? (candidate.generationMetadata as Record<
                          string,
                          unknown
                        >)
                      : {},
                };
              }),
            };
          },
        },
        [input.parentImagePath, ...(input.referenceImagePaths ?? [])].filter(
          (value): value is string => Boolean(value),
        ),
        Array.from(
          new Set(expectedPaths.map((outputPath) => path.dirname(outputPath))),
        ),
      );
      responses.push(result.rawResponse);
      for (const image of result.value.images) {
        metadataByPath.set(path.resolve(image.path), image.generationMetadata);
        promptByPath.set(path.resolve(image.path), image.finalPrompt);
      }

      const stillMissing: string[] = [];
      for (const outputPath of missingPaths) {
        if (!(await isValidImage(outputPath))) {
          // A corrupt partial output belongs to this invocation and must be
          // removed before an exact-path retry can succeed.
          await unlink(outputPath).catch(() => undefined);
          stillMissing.push(outputPath);
        }
      }
      missingPaths = stillMissing;
      if (missingPaths.length === 0) break;
      if (imageAttempt < this.maxRetries) {
        await wait(this.retryDelayMs * (imageAttempt + 1));
      }
    }

    if (missingPaths.length > 0) {
      throw new MissingGeneratedImagesError(missingPaths);
    }

    const images: GeneratedImageResult[] = expectedPaths.map((outputPath) => ({
      path: outputPath,
      finalPrompt: promptByPath.get(outputPath) ?? input.expandedPrompt,
      generationMetadata: metadataByPath.get(outputPath) ?? {
        adapter: "codex",
      },
    }));
    return {
      value: { images },
      prompt: lastPrompt,
      rawResponse: responses.join("\n"),
    };
  }

  async evaluateImage(input: EvaluateImageInput) {
    const prompt = buildEvaluationPrompt(input);
    return this.invoke(prompt, EVALUATION_SCHEMA, evaluationResultSchema, [
      input.imagePath,
    ]);
  }

  async rewritePrompt(input: RewritePromptInput) {
    const prompt = buildRewritePrompt(input);
    return this.invoke(
      prompt,
      REWRITE_PROMPT_SCHEMA,
      rewritePromptResultSchema,
      [input.imagePath],
    );
  }

  async summarizeProjectTitle(originalPrompt: string) {
    const prompt = buildTitlePrompt(originalPrompt);
    return this.invoke(prompt, TITLE_SCHEMA, projectTitleResultSchema, []);
  }

  private async invoke<T>(
    prompt: string,
    schema: JsonSchema,
    validator: Pick<ZodType<T>, "parse">,
    imagePaths: string[],
    writableDirectories: string[] = [],
  ): Promise<AdapterResponse<T>> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.invokeOnce(
          prompt,
          schema,
          validator,
          imagePaths,
          writableDirectories,
        );
      } catch (error) {
        lastError = error;
        if (attempt < this.maxRetries) {
          await wait(this.retryDelayMs * (attempt + 1));
        }
      }
    }
    throw lastError;
  }

  private async invokeOnce<T>(
    prompt: string,
    schema: JsonSchema,
    validator: Pick<ZodType<T>, "parse">,
    imagePaths: string[],
    writableDirectories: string[],
  ): Promise<AdapterResponse<T>> {
    await mkdir(this.isolationRoot, { recursive: true });
    const temporaryDirectory = await mkdtemp(
      path.join(this.isolationRoot, "ievcs-codex-"),
    );
    const schemaPath = path.join(temporaryDirectory, "schema.json");
    const responsePath = path.join(temporaryDirectory, "response.json");
    await writeFile(schemaPath, JSON.stringify(schema), "utf8");

    try {
      const args = [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--sandbox",
        "workspace-write",
      ];
      if (imagePaths.length > 0) {
        args.push(
          "-i",
          ...imagePaths.map((imagePath) => path.resolve(imagePath)),
        );
      }
      for (const writableDirectory of new Set(writableDirectories)) {
        args.push("--add-dir", path.resolve(writableDirectory));
      }
      args.push(
        "--output-schema",
        schemaPath,
        "--output-last-message",
        responsePath,
        "--cd",
        temporaryDirectory,
        "-",
      );

      await this.spawnCodex(args, prompt, temporaryDirectory);
      const rawResponse = await readFile(responsePath, "utf8");
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawResponse);
      } catch (error) {
        throw new Error(
          `Codex returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return {
        value: validator.parse(decoded),
        prompt,
        rawResponse,
      };
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }

  private spawnCodex(
    args: string[],
    prompt: string,
    workingDirectory: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        cwd: workingDirectory,
        env: process.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
        killTimer.unref();
      }, this.timeoutMs);
      timeout.unref();

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (error) reject(error);
        else resolve();
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = appendLimited(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = appendLimited(stderr, chunk);
      });
      child.on("error", (error) => finish(error));
      child.on("close", (exitCode, signal) => {
        if (exitCode === 0 && !timedOut) {
          finish();
          return;
        }
        finish(
          new CodexInvocationError(
            timedOut
              ? `Codex invocation timed out after ${this.timeoutMs}ms`
              : `Codex invocation exited with code ${String(exitCode)}`,
            { exitCode, signal, stdout, stderr, timedOut },
          ),
        );
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(prompt);
    });
  }
}
