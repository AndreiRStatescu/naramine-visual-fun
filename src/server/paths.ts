import path from "node:path";

import { config } from "@/server/config";

const SAFE_PROJECT_ID = /^[a-zA-Z0-9_-]+$/;

export type ProjectPaths = Readonly<{
  root: string;
  images: string;
  thumbnails: string;
  references: string;
  exports: string;
  prompts: string;
  logs: string;
  work: string;
}>;

export function assertSafeProjectId(projectId: string): void {
  if (!SAFE_PROJECT_ID.test(projectId)) {
    throw new Error("Invalid project identifier");
  }
}

function assertContained(base: string, candidate: string): void {
  const relative = path.relative(base, candidate);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) {
    return;
  }

  throw new Error("Path escapes the project storage directory");
}

export function projectPaths(projectId: string): ProjectPaths {
  assertSafeProjectId(projectId);
  const root = path.join(config.projectsDir, projectId);

  return Object.freeze({
    root,
    images: path.join(root, "images"),
    thumbnails: path.join(root, "thumbnails"),
    references: path.join(root, "references"),
    exports: path.join(root, "exports"),
    prompts: path.join(root, "prompts"),
    logs: path.join(root, "logs"),
    work: path.join(root, "work"),
  });
}

/** Resolve a database path that is always stored relative to its project. */
export function resolveProjectRelativePath(
  projectId: string,
  relativePath: string,
): string {
  const { root } = projectPaths(projectId);

  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Invalid project-relative path");
  }

  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Invalid project-relative path");
  }

  const candidate = path.resolve(root, ...segments);
  assertContained(root, candidate);
  return candidate;
}

/** Convert a path to the portable project-relative form persisted in SQLite. */
export function toProjectRelativePath(
  projectId: string,
  absolutePath: string,
): string {
  const { root } = projectPaths(projectId);
  const candidate = path.resolve(absolutePath);
  assertContained(root, candidate);

  const relative = path.relative(root, candidate);
  if (
    !relative ||
    relative.split(path.sep).some((segment) => segment === "..")
  ) {
    throw new Error("A project file, not the project directory, is required");
  }

  return relative.split(path.sep).join("/");
}

export function isPathInside(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
