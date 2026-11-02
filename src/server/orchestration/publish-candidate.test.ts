import {
  access,
  link,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { publishCandidate } from "./run-job";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "ievcs publish test "));
  temporaryDirectories.push(root);
  const staging = path.join(root, "work", "candidate");
  const images = path.join(root, "images");
  const outsideImage = path.join(root, "outside.png");
  await Promise.all([
    mkdir(staging, { recursive: true }),
    mkdir(images, { recursive: true }),
  ]);
  await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: "orange",
    },
  })
    .png()
    .toFile(outsideImage);
  return { root, staging, images, outsideImage };
}

describe("publishCandidate", () => {
  it("copies a private regular staging file to a fresh immutable inode", async () => {
    const { staging, images, outsideImage } = await fixture();
    const stagedPath = path.join(staging, "candidate.png");
    const destinationPath = path.join(images, "candidate.png");
    await sharp(outsideImage).toFile(stagedPath);

    await publishCandidate(stagedPath, destinationPath, staging);

    const published = await lstat(destinationPath);
    expect(published.isFile()).toBe(true);
    expect(published.isSymbolicLink()).toBe(false);
    expect(published.nlink).toBe(1);
    await expect(access(stagedPath)).rejects.toThrow();
  });

  it.each(["symlink", "hardlink"])(
    "rejects a generated %s instead of aliasing another image",
    async (kind) => {
      const { staging, images, outsideImage } = await fixture();
      const stagedPath = path.join(staging, "candidate.png");
      const destinationPath = path.join(images, "candidate.png");
      if (kind === "symlink") await symlink(outsideImage, stagedPath);
      else await link(outsideImage, stagedPath);

      await expect(
        publishCandidate(stagedPath, destinationPath, staging),
      ).rejects.toThrow("not an isolated regular file");
      await expect(access(destinationPath)).rejects.toThrow();
    },
  );
});
