import { NextResponse } from "next/server";

import { ApiError, assertLocalRequest, routeError } from "@/app/api/_lib/http";
import { config } from "@/server/config";
import { db, ensureDatabaseReady } from "@/server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    assertLocalRequest(request);
    await ensureDatabaseReady();
    await db.$queryRawUnsafe("SELECT 1");
    return NextResponse.json({
      status: "ok",
      database: "ready",
      adapter: config.codexAdapterName,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return routeError(error);
    }
    console.error("Health check failed", error);
    return NextResponse.json(
      {
        status: "error",
        database: "unavailable",
        adapter: config.codexAdapterName,
      },
      { status: 503 },
    );
  }
}
