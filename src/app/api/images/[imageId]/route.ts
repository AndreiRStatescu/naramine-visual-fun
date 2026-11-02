import { z } from "zod";

import { assetResponse } from "@/app/api/_lib/assets";
import { ApiError, assertLocalRequest, routeError } from "@/app/api/_lib/http";
import { db, ensureDatabaseReady } from "@/server/db";
import { readProjectAsset, StorageError } from "@/server/storage";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ imageId: string }> };

const imageQuerySchema = z.object({
  thumbnail: z.enum(["0", "1"]).default("0"),
});

export async function GET(request: Request, context: RouteContext) {
  try {
    assertLocalRequest(request);
    await ensureDatabaseReady();
    const { imageId } = await context.params;
    const url = new URL(request.url);
    const { thumbnail } = imageQuerySchema.parse({
      thumbnail: url.searchParams.get("thumbnail") ?? undefined,
    });
    const image = await db.generatedImage.findUnique({
      where: { id: imageId },
      select: {
        projectId: true,
        filePath: true,
        thumbnailPath: true,
        mimeType: true,
        sha256: true,
      },
    });
    const provisional = image
      ? null
      : await db.candidateAttempt.findFirst({
          where: {
            outputPath: `images/${imageId}.png`,
            state: { in: ["EVALUATING", "PREPARED", "COMPLETED"] },
          },
          select: {
            outputPath: true,
            updatedAt: true,
            job: { select: { projectId: true } },
          },
        });
    if (!image && !provisional?.outputPath) {
      throw new ApiError(404, "Image not found", "NOT_FOUND");
    }

    const projectId = image?.projectId ?? provisional!.job.projectId;
    const filePath = image?.filePath ?? provisional!.outputPath!;
    const thumbnailPath = image?.thumbnailPath ?? `thumbnails/${imageId}.webp`;
    const mimeType = image?.mimeType ?? "image/png";
    const etag =
      image?.sha256 ?? `${imageId}-${provisional!.updatedAt.getTime()}`;

    let bytes: Buffer;
    try {
      bytes = await readProjectAsset(
        projectId,
        thumbnail === "1" ? thumbnailPath : filePath,
      );
    } catch (error) {
      if (error instanceof StorageError) {
        throw new ApiError(404, "Image file not found", "NOT_FOUND");
      }
      throw error;
    }

    return assetResponse(bytes, {
      mimeType: thumbnail === "1" ? "image/webp" : mimeType,
      etag: thumbnail === "1" ? `${etag}-thumbnail` : etag,
    });
  } catch (error) {
    return routeError(error);
  }
}
