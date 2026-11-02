import { NextResponse } from "next/server";

import { ApiError, assertLocalRequest, routeError } from "@/app/api/_lib/http";
import { serializeJob } from "@/app/api/_lib/serializers";
import { db, ensureDatabaseReady } from "@/server/db";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    assertLocalRequest(request);
    await ensureDatabaseReady();
    const { jobId } = await context.params;
    const job = await db.job.findUnique({
      where: { id: jobId },
      include: {
        events: { orderBy: { createdAt: "asc" } },
        attempts: {
          orderBy: [
            { round: "asc" },
            { branchIndex: "asc" },
            { candidateIndex: "asc" },
          ],
        },
      },
    });
    if (!job) throw new ApiError(404, "Job not found", "NOT_FOUND");
    return NextResponse.json({ job: serializeJob(job) });
  } catch (error) {
    return routeError(error);
  }
}
