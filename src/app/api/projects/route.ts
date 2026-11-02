import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";
import { z } from "zod";

import { imageFilesFromForm, optionalFormString } from "@/app/api/_lib/files";
import {
  ApiError,
  assertLocalMutationRequest,
  assertLocalRequest,
  readJson,
  routeError,
} from "@/app/api/_lib/http";
import { queuedFirstRoundAttempts } from "@/app/api/_lib/provisional-graph";
import { serializeJob, serializeReference } from "@/app/api/_lib/serializers";
import { createProjectSchema, jobPayloadSchema } from "@/lib/contracts";
import { db, ensureDatabaseReady } from "@/server/db";
import {
  ensureProjectStorage,
  removeStoredFiles,
  storeReferenceFiles,
  type StoredReference,
} from "@/server/storage";

export const runtime = "nodejs";

const listProjectsSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function fallbackTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/, 1)[0].replace(/\s+/g, " ").trim();
  if (firstLine.length <= 72) return firstLine;
  return `${firstLine.slice(0, 69).trimEnd()}…`;
}

function publicProject(project: {
  id: string;
  title: string;
  originalPrompt: string;
  variantsPerRevision: number;
  optimizationRounds: number;
  survivorsPerRound: number;
  createdAt: Date;
  updatedAt: Date;
  lastOpenedAt: Date;
}) {
  return {
    id: project.id,
    title: project.title,
    originalPrompt: project.originalPrompt,
    variantsPerRevision: project.variantsPerRevision,
    optimizationRounds: project.optimizationRounds,
    survivorsPerRound: project.survivorsPerRound,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastOpenedAt: project.lastOpenedAt,
  };
}

async function parseCreateRequest(request: Request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const referenceIdsValue = optionalFormString(form, "referenceIds");
    let referenceIds: unknown = [];
    if (referenceIdsValue) {
      try {
        referenceIds = JSON.parse(referenceIdsValue);
      } catch {
        throw new ApiError(400, "referenceIds must be a JSON array");
      }
    }

    const input = createProjectSchema.parse({
      originalPrompt: optionalFormString(form, "originalPrompt"),
      title: optionalFormString(form, "title") || undefined,
      variantsPerRevision: optionalFormString(form, "variantsPerRevision"),
      optimizationRounds: optionalFormString(form, "optimizationRounds"),
      survivorsPerRound: optionalFormString(form, "survivorsPerRound"),
      referenceIds,
    });
    return { input, files: imageFilesFromForm(form) };
  }

  const input = createProjectSchema.parse(await readJson(request));
  return { input, files: [] as File[] };
}

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    await ensureDatabaseReady();
    const url = new URL(request.url);
    const { limit } = listProjectsSchema.parse({
      limit: url.searchParams.get("limit") ?? undefined,
    });
    const projects = await db.project.findMany({
      orderBy: [{ lastOpenedAt: "desc" }, { createdAt: "desc" }],
      take: limit,
      include: {
        _count: { select: { revisions: true, images: true } },
        images: {
          orderBy: [{ selected: "desc" }, { createdAt: "desc" }],
          take: 1,
          select: { id: true },
        },
        jobs: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });

    return NextResponse.json({
      projects: projects.map((project) => ({
        ...publicProject(project),
        revisionCount: project._count.revisions,
        imageCount: project._count.images,
        coverImage: project.images[0]
          ? {
              id: project.images[0].id,
              thumbnailUrl: `/api/images/${encodeURIComponent(project.images[0].id)}?thumbnail=1`,
            }
          : null,
        latestJob: project.jobs[0] ? serializeJob(project.jobs[0]) : null,
      })),
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request) {
  let storedReferences: StoredReference[] = [];
  let referencesPersisted = false;
  try {
    assertLocalMutationRequest(request);
    await ensureDatabaseReady();
    const { input, files } = await parseCreateRequest(request);
    if (input.referenceIds.length > 0) {
      throw new ApiError(
        400,
        "A new project cannot select existing reference IDs; upload reference files instead",
      );
    }

    const projectId = randomUUID();
    await ensureProjectStorage(projectId);
    storedReferences = await storeReferenceFiles(projectId, files);
    const referenceIds = storedReferences.map(({ id }) => id);
    const payload = jobPayloadSchema.parse({
      mode: "INITIAL",
      originalPrompt: input.originalPrompt,
      referenceIds,
      variantsPerRevision: input.variantsPerRevision,
      optimizationRounds: input.optimizationRounds,
      survivorsPerRound: input.survivorsPerRound,
    });
    const now = new Date();
    const jobId = randomUUID();

    const result = await db.$transaction(async (transaction) => {
      const project = await transaction.project.create({
        data: {
          id: projectId,
          title: input.title ?? fallbackTitle(input.originalPrompt),
          originalPrompt: input.originalPrompt,
          variantsPerRevision: input.variantsPerRevision,
          optimizationRounds: input.optimizationRounds,
          survivorsPerRound: input.survivorsPerRound,
          lastOpenedAt: now,
          references: {
            create: storedReferences.map((reference) => ({
              id: reference.id,
              originalName: reference.originalName,
              filePath: reference.filePath,
              mimeType: reference.mimeType,
              sha256: reference.sha256,
              width: reference.width,
              height: reference.height,
            })),
          },
        },
      });
      const job = await transaction.job.create({
        data: {
          id: jobId,
          projectId,
          type: "OPTIMIZE",
          state: "QUEUED",
          payloadJson: JSON.stringify(payload),
          totalRounds: payload.optimizationRounds,
          attempts: {
            create: queuedFirstRoundAttempts(
              jobId,
              payload.variantsPerRevision,
              payload.originalPrompt,
            ),
          },
          events: {
            create: {
              id: randomUUID(),
              level: "INFO",
              kind: "QUEUED",
              message: "Initial exploration queued",
              dataJson: JSON.stringify({ referenceIds }),
            },
          },
        },
      });
      return { project, job };
    });
    referencesPersisted = true;

    return NextResponse.json(
      {
        project: {
          ...publicProject(result.project),
          references: storedReferences.map((reference) =>
            serializeReference({ ...reference, createdAt: now }),
          ),
        },
        job: serializeJob(result.job),
      },
      { status: 201 },
    );
  } catch (error) {
    if (!referencesPersisted && storedReferences.length > 0) {
      await removeStoredFiles(storedReferences).catch(() => undefined);
    }
    return routeError(error);
  }
}
