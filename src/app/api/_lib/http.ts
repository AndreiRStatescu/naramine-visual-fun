import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { StorageError } from "@/server/storage";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

export function assertLocalRequest(request: Request): URL {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    throw new ApiError(403, "Request host is not allowed", "FORBIDDEN");
  }
  if (!isLoopbackHostname(requestUrl.hostname)) {
    throw new ApiError(
      403,
      "Requests are restricted to localhost",
      "FORBIDDEN",
    );
  }

  const host = request.headers.get("host");
  if (host) {
    let hostUrl: URL;
    try {
      hostUrl = new URL(`${requestUrl.protocol}//${host}`);
    } catch {
      throw new ApiError(403, "Request host is not allowed", "FORBIDDEN");
    }
    if (!isLoopbackHostname(hostUrl.hostname)) {
      throw new ApiError(
        403,
        "Requests are restricted to localhost",
        "FORBIDDEN",
      );
    }

    // Next may normalize Request.url to localhost even when the browser used
    // 127.0.0.1. Host is the browser-facing authority and cannot be set by
    // page JavaScript, so use the already-validated value for origin checks.
    const browserFacingUrl = new URL(requestUrl);
    browserFacingUrl.host = hostUrl.host;
    return browserFacingUrl;
  }
  return requestUrl;
}

/**
 * This app intentionally has no authentication, so browser mutations are
 * accepted only from the same loopback origin. Origin-less local tools such as
 * curl remain supported, but cross-site browser requests are rejected before
 * they can enqueue subscription-backed work.
 */
export function assertLocalMutationRequest(request: Request): void {
  const requestUrl = assertLocalRequest(request);

  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
    throw new ApiError(
      403,
      "Cross-site mutation request rejected",
      "FORBIDDEN",
    );
  }

  const origin = request.headers.get("origin");
  if (!origin) return;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new ApiError(
      403,
      "Mutation request origin is not allowed",
      "FORBIDDEN",
    );
  }
  if (
    !isLoopbackHostname(originUrl.hostname) ||
    originUrl.origin !== requestUrl.origin
  ) {
    throw new ApiError(
      403,
      "Cross-origin mutation request rejected",
      "FORBIDDEN",
    );
  }
}

export function jsonError(
  status: number,
  message: string,
  code?: string,
  details?: unknown,
) {
  return NextResponse.json(
    {
      error: {
        message,
        ...(code ? { code } : {}),
        ...(details === undefined ? {} : { details }),
      },
    },
    { status },
  );
}

export function routeError(error: unknown) {
  if (error instanceof ApiError) {
    return jsonError(error.status, error.message, error.code);
  }

  if (error instanceof ZodError) {
    return jsonError(
      400,
      "Request validation failed",
      "VALIDATION_ERROR",
      error.issues,
    );
  }

  if (error instanceof StorageError) {
    return jsonError(400, error.message, "INVALID_ASSET");
  }

  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  ) {
    return jsonError(404, "Resource not found", "NOT_FOUND");
  }

  console.error("Unhandled API error", error);
  return jsonError(500, "Internal server error", "INTERNAL_ERROR");
}

export async function readJson(request: Request): Promise<unknown> {
  assertLocalMutationRequest(request);
  if (!request.headers.get("content-type")?.includes("application/json")) {
    throw new ApiError(
      415,
      "Expected an application/json request",
      "UNSUPPORTED_MEDIA_TYPE",
    );
  }

  try {
    return await request.json();
  } catch {
    throw new ApiError(400, "Request body is not valid JSON", "INVALID_JSON");
  }
}
