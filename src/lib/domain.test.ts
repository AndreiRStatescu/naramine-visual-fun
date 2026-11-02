import { describe, expect, it } from "vitest";

import { expectedImageCount, selectSurvivors } from "@/lib/domain";

describe("optimization topology", () => {
  it("fans four children out from each of two survivors", () => {
    expect(expectedImageCount(4, 3, 2)).toBe(20);
  });

  it("uses stable IDs to break equal-score ties", () => {
    const selected = selectSurvivors(
      [
        { value: "third", score: 88, stableId: "c" },
        { value: "first", score: 88, stableId: "a" },
        { value: "second", score: 88, stableId: "b" },
      ],
      2,
    );

    expect(selected.map(({ value }) => value)).toEqual(["first", "second"]);
  });
});
