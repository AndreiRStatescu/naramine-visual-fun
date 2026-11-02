import { NextResponse } from "next/server";

import { imageFilesFromForm } from "@/app/api/_lib/files";
import {
  ApiError,
  assertLocalMutationRequest,
  assertLocalRequest,
  routeError,
} from "@/app/api/_lib/http";
import { serializeReference } from "@/app/api/_lib/serializers";
import { db, ensureDatabaseReady } from "@/server/db";
import {
  removeStoredFiles,
  storeReferenceFiles,
  type StoredReference,
} from "@/server/storage";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ projectId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    assertLocalRequest(request);
    await ensureDatabaseReady();
    const { projectId } = await context.params;
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        references: { orderBy: { createdAt: "asc" } },
      },
    });
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    return NextResponse.json({
      references: project.references.map(serializeReference),
    });
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  let storedReferences: StoredReference[] = [];
  let referencesPersisted = false;
  try {
    assertLocalMutationRequest(request);
    await ensureDatabaseReady();
    if (!request.headers.get("content-type")?.includes("multipart/form-data")) {
      throw new ApiError(415, "Expected a multipart/form-data request");
    }

    const { projectId } = await context.params;
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true },
    });
    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");

    const form = await request.formData();
    const files = imageFilesFromForm(form);
    if (files.length === 0) {
      throw new ApiError(400, "Upload at least one reference image");
    }

    storedReferences = await storeReferenceFiles(projectId, files);
    const references = await db.$transaction(
      storedReferences.map((reference) =>
        db.referenceAsset.create({
          data: {
            id: reference.id,
            projectId,
            originalName: reference.originalName,
            filePath: reference.filePath,
            mimeType: reference.mimeType,
            sha256: reference.sha256,
            width: reference.width,
            height: reference.height,
          },
        }),
      ),
    );
    referencesPersisted = true;

    return NextResponse.json(
      { references: references.map(serializeReference) },
      { status: 201 },
    );
  } catch (error) {
    if (!referencesPersisted && storedReferences.length > 0) {
      await removeStoredFiles(storedReferences).catch(() => undefined);
    }
    return routeError(error);
  }
}
