import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  link,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import sharp, { type Metadata } from "sharp";

import { config } from "@/server/config";
import {
  isPathInside,
  projectPaths,
  resolveProjectRelativePath,
  toProjectRelativePath,
  type ProjectPaths,
} from "@/server/paths";

const REFERENCE_FORMATS = {
  jpeg: { extension: "jpg", mimeType: "image/jpeg" },
  png: { extension: "png", mimeType: "image/png" },
  webp: { extension: "webp", mimeType: "image/webp" },
  avif: { extension: "avif", mimeType: "image/avif" },
} as const;

type ReferenceFormat = keyof typeof REFERENCE_FORMATS;

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}

export type StoredReference = {
  id: string;
  originalName: string;
  filePath: string;
  absolutePath: string;
  mimeType: string;
  sha256: string;
  width: number;
  height: number;
};

const DEFAULT_PLANNER_PROMPT = `# Image prompt planner

Expand the original project prompt into a precise image-generation prompt.
Preserve the user's intent, account for the optional parent and edit direction,
and treat up to two supplied reference images as immutable visual context.
`;

const DEFAULT_EVALUATOR_PROMPT = `# Image evaluator

Evaluate one generated image only against the original project prompt and the
image itself. Return a 0-100 score, strengths, weaknesses, recommended
improvements, and concise reasoning. Do not reward later planning context.
`;

async function writeOnce(filePath: string, contents: string): Promise<void> {
  try {
    await writeFile(filePath, contents, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export async function ensureProjectStorage(
  projectId: string,
): Promise<ProjectPaths> {
  const paths = projectPaths(projectId);
  await Promise.all(
    Object.values(paths).map((directory) =>
      mkdir(directory, { recursive: true }),
    ),
  );
  await Promise.all([
    writeOnce(path.join(paths.prompts, "planner.md"), DEFAULT_PLANNER_PROMPT),
    writeOnce(
      path.join(paths.prompts, "evaluator.md"),
      DEFAULT_EVALUATOR_PROMPT,
    ),
  ]);
  return paths;
}

function cleanOriginalName(name: string): string {
  const baseName = path.basename(name).replace(/[\u0000-\u001f\u007f]/g, "");
  return (baseName || "reference-image").slice(0, 255);
}

export async function storeReferenceFile(
  projectId: string,
  file: File,
): Promise<StoredReference> {
  if (file.size <= 0) {
    throw new StorageError("Reference image is empty");
  }
  if (file.size > config.maxReferenceBytes) {
    throw new StorageError(
      `Reference image exceeds the ${Math.floor(config.maxReferenceBytes / 1_048_576)} MB limit`,
    );
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  let metadata: Metadata;
  try {
    metadata = await sharp(bytes, { failOn: "error" }).metadata();
  } catch {
    throw new StorageError("Reference must be a valid image");
  }

  const format = metadata.format as ReferenceFormat | undefined;
  const formatInfo = format ? REFERENCE_FORMATS[format] : undefined;
  if (!formatInfo || !metadata.width || !metadata.height) {
    throw new StorageError(
      "Reference must be a PNG, JPEG, WebP, or AVIF image",
    );
  }

  const id = randomUUID();
  const paths = await ensureProjectStorage(projectId);
  const absolutePath = path.join(
    /* turbopackIgnore: true */ paths.references,
    `${id}.${formatInfo.extension}`,
  );
  const temporaryPath = path.join(
    /* turbopackIgnore: true */ paths.references,
    `.${id}.uploading`,
  );

  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    // A hard link publishes atomically without ever replacing an existing file.
    await link(temporaryPath, absolutePath);
    await rm(temporaryPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }

  return {
    id,
    originalName: cleanOriginalName(file.name),
    filePath: toProjectRelativePath(projectId, absolutePath),
    absolutePath,
    mimeType: formatInfo.mimeType,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    width: metadata.width,
    height: metadata.height,
  };
}

export async function storeReferenceFiles(
  projectId: string,
  files: File[],
): Promise<StoredReference[]> {
  if (files.length > 2) {
    throw new StorageError("A revision can use at most two reference images");
  }

  const stored: StoredReference[] = [];
  try {
    // Keep writes sequential so a failure has deterministic cleanup.
    for (const file of files) {
      stored.push(await storeReferenceFile(projectId, file));
    }
    return stored;
  } catch (error) {
    await Promise.all(
      stored.map(({ absolutePath }) => rm(absolutePath, { force: true })),
    );
    throw error;
  }
}

export async function removeStoredFiles(
  files: Array<{ absolutePath: string }>,
): Promise<void> {
  await Promise.all(
    files.map(({ absolutePath }) => rm(absolutePath, { force: true })),
  );
}

export async function createThumbnail(
  sourceAbsolutePath: string,
  destinationAbsolutePath: string,
): Promise<{ width: number; height: number }> {
  await mkdir(path.dirname(destinationAbsolutePath), { recursive: true });
  const { data, info } = await sharp(sourceAbsolutePath, { failOn: "error" })
    .rotate()
    .resize({
      width: 512,
      height: 512,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });

  await writeFile(destinationAbsolutePath, data, { flag: "wx" });
  return { width: info.width, height: info.height };
}

/**
 * Read only regular files whose real path remains inside their project root.
 * The realpath check also closes the symlink escape that a lexical check alone
 * would leave open.
 */
export async function readProjectAsset(
  projectId: string,
  relativePath: string,
): Promise<Buffer> {
  let paths: ProjectPaths;
  let candidate: string;
  try {
    paths = projectPaths(projectId);
    candidate = resolveProjectRelativePath(projectId, relativePath);
  } catch {
    throw new StorageError("Asset not found");
  }

  let realRoot: string;
  let realCandidate: string;
  try {
    [realRoot, realCandidate] = await Promise.all([
      realpath(paths.root),
      realpath(candidate),
    ]);
  } catch {
    throw new StorageError("Asset not found");
  }

  if (!isPathInside(realRoot, realCandidate)) {
    throw new StorageError("Asset not found");
  }

  const fileStat = await stat(realCandidate);
  if (!fileStat.isFile()) {
    throw new StorageError("Asset not found");
  }

  // Assets are runtime data outside the application bundle. Without this
  // hint, Next's file tracer conservatively includes the entire workspace.
  return readFile(/* turbopackIgnore: true */ realCandidate);
}
