import { NextResponse } from "next/server";

import { ApiError, readJson, routeError } from "@/app/api/_lib/http";
import { canvasPositionsSchema } from "@/lib/contracts";
import { db, ensureDatabaseReady } from "@/server/db";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ projectId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    await ensureDatabaseReady();
    const { projectId } = await context.params;
    const { positions } = canvasPositionsSchema.parse(await readJson(request));
    // Last occurrence wins if a client sends an image twice in one drag flush.
    const uniquePositions = [
      ...new Map(
        positions.map((position) => [position.imageId, position]),
      ).values(),
    ];
    const imageIds = uniquePositions.map(({ imageId }) => imageId);
    const images = await db.generatedImage.findMany({
      where: { projectId, id: { in: imageIds } },
      select: { id: true },
    });
    if (images.length !== imageIds.length) {
      throw new ApiError(
        400,
        "Every position must refer to an image in this project",
      );
    }

    await db.$transaction(
      uniquePositions.map(({ imageId, x, y }) =>
        db.canvasPosition.upsert({
          where: { imageId },
          create: { imageId, x, y },
          update: { x, y },
        }),
      ),
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    return routeError(error);
  }
}
