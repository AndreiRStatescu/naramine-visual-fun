import { describe, expect, it } from "vitest";

import {
  ApiError,
  assertLocalMutationRequest,
  assertLocalRequest,
} from "./http";

function request(
  url = "http://127.0.0.1:3000/api/projects",
  headers: Record<string, string> = {},
) {
  return new Request(url, { method: "POST", headers });
}

describe("local mutation guard", () => {
  it("accepts same-origin browser requests and origin-less local tools", () => {
    expect(() => assertLocalMutationRequest(request())).not.toThrow();
    expect(() =>
      assertLocalMutationRequest(
        request(undefined, {
          origin: "http://127.0.0.1:3000",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).not.toThrow();
  });

  it("uses the validated Host when Next normalizes the request URL", () => {
    expect(() =>
      assertLocalMutationRequest(
        request("http://localhost:3000/api/projects", {
          host: "127.0.0.1:3000",
          origin: "http://127.0.0.1:3000",
          "sec-fetch-site": "same-origin",
        }),
      ),
    ).not.toThrow();

    for (const origin of [
      "http://localhost:3000",
      "http://127.0.0.1:3001",
      "https://127.0.0.1:3000",
    ]) {
      expect(() =>
        assertLocalMutationRequest(
          request("http://localhost:3000/api/projects", {
            host: "127.0.0.1:3000",
            origin,
          }),
        ),
      ).toThrowError(
        expect.objectContaining<Partial<ApiError>>({ status: 403 }),
      );
    }

    expect(() =>
      assertLocalMutationRequest(
        request("http://localhost:3000/api/projects", {
          host: "127.0.0.1:3000",
          origin: "http://localhost:3000",
          "x-forwarded-host": "localhost:3000",
        }),
      ),
    ).toThrowError(expect.objectContaining<Partial<ApiError>>({ status: 403 }));
  });

  it("rejects cross-site and non-loopback mutations", () => {
    for (const candidate of [
      request(undefined, { origin: "https://attacker.example" }),
      request(undefined, { "sec-fetch-site": "cross-site" }),
      request("http://app.example/api/projects"),
    ]) {
      expect(() => assertLocalMutationRequest(candidate)).toThrowError(
        expect.objectContaining<Partial<ApiError>>({ status: 403 }),
      );
    }
  });

  it("rejects a non-loopback Host header on reads", () => {
    expect(() =>
      assertLocalRequest(request(undefined, { host: "attacker.example:3000" })),
    ).toThrowError(expect.objectContaining({ status: 403 }));
  });
});
