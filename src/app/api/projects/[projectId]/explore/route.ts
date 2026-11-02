import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { ApiError, readJson, routeError } from "@/app/api/_lib/http";
import { queuedFirstRoundAttempts } from "@/app/api/_lib/provisional-graph";
import { serializeJob } from "@/app/api/_lib/serializers";
import { exploreSchema, jobPayloadSchema } from "@/lib/contracts";
import { db, ensureDatabaseReady } from "@/server/db";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ projectId: string }> };

export async function POST(request: Request, context: RouteContext) {
  try {
    await ensureDatabaseReady();
    const { projectId } = await context.params;
    const input = exploreSchema.parse(await readJson(request));
    const uniqueReferenceIds = [...new Set(input.referenceIds)];
    if (uniqueReferenceIds.length !== input.referenceIds.length) {
      throw new ApiError(400, "Reference IDs must be unique");
    }

    const [project, sourceImage, referenceCount] = await Promise.all([
      db.project.findUnique({ where: { id: projectId } }),
      db.generatedImage.findFirst({
        where: { id: input.sourceImageId, projectId },
        select: { id: true },
      }),
      uniqueReferenceIds.length === 0
        ? Promise.resolve(0)
        : db.referenceAsset.count({
            where: { projectId, id: { in: uniqueReferenceIds } },
          }),
    ]);

    if (!project) throw new ApiError(404, "Project not found", "NOT_FOUND");
    if (!sourceImage) {
      throw new ApiError(
        404,
        "Source image not found in this project",
        "NOT_FOUND",
      );
    }
    if (referenceCount !== uniqueReferenceIds.length) {
      throw new ApiError(
        400,
        "Every selected reference must belong to this project",
      );
    }

    const variantsPerRevision =
      input.variantsPerRevision ?? project.variantsPerRevision;
    const optimizationRounds =
      input.optimizationRounds ?? project.optimizationRounds;
    const survivorsPerRound =
      input.survivorsPerRound ?? project.survivorsPerRound;
    if (survivorsPerRound > variantsPerRevision) {
      throw new ApiError(400, "Survivors cannot exceed variants per revision");
    }

    const payload = jobPayloadSchema.parse({
      mode: "EXPLORE",
      originalPrompt: project.originalPrompt,
      sourceImageId: sourceImage.id,
      editPrompt: input.editPrompt || undefined,
      referenceIds: uniqueReferenceIds,
      variantsPerRevision,
      optimizationRounds,
      survivorsPerRound,
    });
    const jobId = randomUUID();
    const job = await db.$transaction((transaction) =>
      transaction.job.create({
        data: {
          id: jobId,
          projectId,
          type: "EXPLORE",
          state: "QUEUED",
          payloadJson: JSON.stringify(payload),
          totalRounds: optimizationRounds,
          attempts: {
            create: queuedFirstRoundAttempts(
              jobId,
              variantsPerRevision,
              input.editPrompt || project.originalPrompt,
              sourceImage.id,
            ),
          },
          events: {
            create: {
              id: randomUUID(),
              level: "INFO",
              kind: "QUEUED",
              message: "Image exploration queued",
              dataJson: JSON.stringify({
                sourceImageId: sourceImage.id,
                referenceIds: uniqueReferenceIds,
              }),
            },
          },
        },
      }),
    );

    return NextResponse.json({ job: serializeJob(job) }, { status: 202 });
  } catch (error) {
    return routeError(error);
  }
}
