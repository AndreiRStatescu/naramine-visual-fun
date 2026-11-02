import { assetResponse } from "@/app/api/_lib/assets";
import { ApiError, assertLocalRequest, routeError } from "@/app/api/_lib/http";
import { db, ensureDatabaseReady } from "@/server/db";
import { readProjectAsset, StorageError } from "@/server/storage";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ referenceId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    assertLocalRequest(request);
    await ensureDatabaseReady();
    const { referenceId } = await context.params;
    const reference = await db.referenceAsset.findUnique({
      where: { id: referenceId },
      select: {
        projectId: true,
        filePath: true,
        mimeType: true,
        sha256: true,
      },
    });
    if (!reference) {
      throw new ApiError(404, "Reference not found", "NOT_FOUND");
    }

    let bytes: Buffer;
    try {
      bytes = await readProjectAsset(reference.projectId, reference.filePath);
    } catch (error) {
      if (error instanceof StorageError) {
        throw new ApiError(404, "Reference file not found", "NOT_FOUND");
      }
      throw error;
    }

    return assetResponse(bytes, {
      mimeType: reference.mimeType,
      etag: reference.sha256,
    });
  } catch (error) {
    return routeError(error);
  }
}
