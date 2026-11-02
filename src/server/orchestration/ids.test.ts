import { describe, expect, it } from "vitest";

import { attemptIdFor, imageIdFor, revisionIdFor } from "./ids";

describe("orchestration IDs", () => {
  it("are stable across worker restarts and distinct across branches", () => {
    expect(revisionIdFor("job-1", 2, 0)).toBe(revisionIdFor("job-1", 2, 0));
    expect(revisionIdFor("job-1", 2, 0)).not.toBe(revisionIdFor("job-1", 2, 1));
    expect(imageIdFor("job-1", 2, 0, 3)).not.toBe(
      attemptIdFor("job-1", 2, 0, 3),
    );
  });
});
