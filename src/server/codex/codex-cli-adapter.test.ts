import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { CodexCliAdapter } from "./codex-cli-adapter";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.MOCK_CODEX_ARGS_PATH;
  delete process.env.MOCK_CODEX_COUNT_PATH;
  delete process.env.MOCK_CODEX_INVALID_TEMPLATE_PATH;
  delete process.env.MOCK_CODEX_OUTPUT_PATH;
  delete process.env.MOCK_CODEX_PROMPT_PATH;
  delete process.env.MOCK_CODEX_TEMPLATE_PATH;
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("CodexCliAdapter", () => {
  it("invokes codex with argv, ephemeral structured output, and one image", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ievcs cli test "));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "mock codex");
    const argsPath = path.join(directory, "args.json");
    const promptPath = path.join(directory, "prompt.txt");
    const imagePath = path.join(directory, "image.png");
    process.env.MOCK_CODEX_ARGS_PATH = argsPath;
    process.env.MOCK_CODEX_PROMPT_PATH = promptPath;

    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.MOCK_CODEX_ARGS_PATH, JSON.stringify(args));
  fs.writeFileSync(process.env.MOCK_CODEX_PROMPT_PATH, prompt);
  const output = args[args.indexOf("--output-last-message") + 1];
  fs.writeFileSync(output, JSON.stringify({
    score: 73,
    strengths: ["clear subject"],
    weaknesses: ["flat shadows"],
    recommendedImprovements: ["shape the light"],
    reasoning: "The requested subject is legible."
  }));
});
`,
      "utf8",
    );
    await chmod(executable, 0o755);
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: "blue",
      },
    })
      .png()
      .toFile(imagePath);

    const adapter = new CodexCliAdapter({
      binary: executable,
      cwd: directory,
      maxRetries: 0,
      timeoutMs: 5_000,
    });
    const result = await adapter.evaluateImage({
      originalPrompt: "A blue square",
      imagePath,
    });

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    expect(args[0]).toBe("exec");
    expect(args).toContain("--ephemeral");
    expect(args).toContain("--output-schema");
    expect(args).toContain("-i");
    expect(args[args.indexOf("-i") + 1]).toBe(imagePath);
    const invocationDirectory = args[args.indexOf("--cd") + 1];
    expect(invocationDirectory).not.toBe(directory);
    expect(path.dirname(invocationDirectory!)).toBe(directory);
    expect(await readFile(promptPath, "utf8")).toContain("A blue square");
    expect(result.value.score).toBe(73);
  });

  it("grants generation write access only to the supplied staging directory", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ievcs isolation test "),
    );
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "mock codex");
    const argsPath = path.join(directory, "args.json");
    const templatePath = path.join(directory, "template.png");
    const stagingDirectory = path.join(directory, "job-1", "candidate-1");
    const outputPath = path.join(stagingDirectory, "candidate.png");
    await mkdir(stagingDirectory, { recursive: true });
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: "purple",
      },
    })
      .png()
      .toFile(templatePath);
    process.env.MOCK_CODEX_ARGS_PATH = argsPath;
    process.env.MOCK_CODEX_OUTPUT_PATH = outputPath;
    process.env.MOCK_CODEX_TEMPLATE_PATH = templatePath;

    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.MOCK_CODEX_ARGS_PATH, JSON.stringify(args));
  fs.copyFileSync(process.env.MOCK_CODEX_TEMPLATE_PATH, process.env.MOCK_CODEX_OUTPUT_PATH);
  const response = args[args.indexOf("--output-last-message") + 1];
  fs.writeFileSync(response, JSON.stringify({
    images: [{
      path: process.env.MOCK_CODEX_OUTPUT_PATH,
      finalPrompt: "A distinct purple square",
      generationMetadata: { notes: "mock generation" }
    }]
  }));
});
`,
      "utf8",
    );
    await chmod(executable, 0o755);

    const adapter = new CodexCliAdapter({
      binary: executable,
      cwd: directory,
      maxRetries: 0,
      timeoutMs: 5_000,
    });
    await adapter.generateImages({
      expandedPrompt: "A purple square",
      outputPaths: [outputPath],
      candidateKeys: ["candidate-1"],
      candidateIndex: 0,
      candidateCount: 4,
    });

    const args = JSON.parse(await readFile(argsPath, "utf8")) as string[];
    expect(args[args.indexOf("--add-dir") + 1]).toBe(stagingDirectory);
    expect(args[args.indexOf("--cd") + 1]).not.toBe(process.cwd());
    expect((await sharp(outputPath).metadata()).format).toBe("png");
  });

  it("retries an output that exists but is not a PNG", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ievcs png retry "));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "mock codex");
    const countPath = path.join(directory, "count.txt");
    const invalidTemplatePath = path.join(directory, "invalid.jpg");
    const validTemplatePath = path.join(directory, "valid.png");
    const stagingDirectory = path.join(directory, "candidate");
    const outputPath = path.join(stagingDirectory, "candidate.png");
    await mkdir(stagingDirectory, { recursive: true });
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: "orange",
      },
    })
      .jpeg()
      .toFile(invalidTemplatePath);
    await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: "green",
      },
    })
      .png()
      .toFile(validTemplatePath);
    process.env.MOCK_CODEX_COUNT_PATH = countPath;
    process.env.MOCK_CODEX_INVALID_TEMPLATE_PATH = invalidTemplatePath;
    process.env.MOCK_CODEX_OUTPUT_PATH = outputPath;
    process.env.MOCK_CODEX_TEMPLATE_PATH = validTemplatePath;

    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
process.stdin.resume();
process.stdin.on("end", () => {
  const countPath = process.env.MOCK_CODEX_COUNT_PATH;
  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) : 0;
  fs.writeFileSync(countPath, String(count + 1));
  fs.copyFileSync(
    count === 0 ? process.env.MOCK_CODEX_INVALID_TEMPLATE_PATH : process.env.MOCK_CODEX_TEMPLATE_PATH,
    process.env.MOCK_CODEX_OUTPUT_PATH
  );
  const response = args[args.indexOf("--output-last-message") + 1];
  fs.writeFileSync(response, JSON.stringify({
    images: [{
      path: process.env.MOCK_CODEX_OUTPUT_PATH,
      finalPrompt: "A distinct green square",
      generationMetadata: { notes: "format retry" }
    }]
  }));
});
`,
      "utf8",
    );
    await chmod(executable, 0o755);

    const adapter = new CodexCliAdapter({
      binary: executable,
      cwd: directory,
      maxRetries: 1,
      retryDelayMs: 1,
      timeoutMs: 5_000,
    });
    await adapter.generateImages({
      expandedPrompt: "A green square",
      outputPaths: [outputPath],
      candidateKeys: ["candidate-format-retry"],
      candidateIndex: 0,
      candidateCount: 4,
    });

    expect(await readFile(countPath, "utf8")).toBe("2");
    expect((await sharp(outputPath).metadata()).format).toBe("png");
  });
});
