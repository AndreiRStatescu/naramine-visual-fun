import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { createCodexAdapter, FakeCodexAdapter } from "./index";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ievcs-fake-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("FakeCodexAdapter", () => {
  it("creates valid, deterministic PNG files", async () => {
    const firstDirectory = await temporaryDirectory();
    const secondDirectory = await temporaryDirectory();
    const firstPath = path.join(firstDirectory, "candidate.png");
    const secondPath = path.join(secondDirectory, "candidate.png");
    const adapter = new FakeCodexAdapter();

    await adapter.generateImages({
      expandedPrompt: "A paper observatory under a violet sky",
      candidateKeys: ["round-1-candidate-0"],
      outputPaths: [firstPath],
      candidateIndex: 0,
      candidateCount: 4,
    });
    await adapter.generateImages({
      expandedPrompt: "A paper observatory under a violet sky",
      candidateKeys: ["round-1-candidate-0"],
      outputPaths: [secondPath],
      candidateIndex: 0,
      candidateCount: 4,
    });

    expect(await readFile(firstPath)).toEqual(await readFile(secondPath));
    await expect(sharp(firstPath).metadata()).resolves.toMatchObject({
      format: "png",
      width: 512,
      height: 512,
    });
  });

  it("evaluates each image independently on the 0-100 scale", async () => {
    const directory = await temporaryDirectory();
    const imagePath = path.join(directory, "candidate.png");
    const adapter = new FakeCodexAdapter();
    await adapter.generateImages({
      expandedPrompt: "A cobalt ceramic fox",
      candidateKeys: ["fox-0"],
      outputPaths: [imagePath],
      candidateIndex: 0,
      candidateCount: 4,
    });

    const first = await adapter.evaluateImage({
      originalPrompt: "A ceramic fox",
      imagePath,
    });
    const second = await adapter.evaluateImage({
      originalPrompt: "A ceramic fox",
      imagePath,
    });

    expect(first.value).toEqual(second.value);
    expect(first.value.score).toBeGreaterThanOrEqual(0);
    expect(first.value.score).toBeLessThanOrEqual(100);
    expect(first.prompt).not.toContain("cobalt");
  });

  it("keeps the real adapter opt-in", () => {
    expect(createCodexAdapter("fake")).toBeInstanceOf(FakeCodexAdapter);
    expect(() => createCodexAdapter("unexpected")).toThrow(
      /Unsupported CODEX_ADAPTER/,
    );
  });
});
