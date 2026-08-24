import { describe, expect, it } from "vitest";
import { boundedIn } from "./boundedIn.js";

describe("boundedIn", () => {
  it("pads up to the next power of two by repeating the last element", () => {
    expect(boundedIn(["a", "b", "c"])).toEqual(["a", "b", "c", "c"]);
    expect(boundedIn([1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5, 5, 5, 5]);
  });

  it("never pads with null, which would break NOT IN", () => {
    const padded = boundedIn(["a", "b", "c"]);

    expect(padded).not.toContain(null);
    expect(padded).not.toContain(undefined);
    expect(padded.every((value) => value === "a" || value === "b" || value === "c")).toBe(true);
  });

  it("collapses arity 1..300 to 10 distinct lengths", () => {
    const lengths = new Set<number>();

    for (let arity = 1; arity <= 300; arity++) {
      lengths.add(boundedIn(Array.from({ length: arity }, (_, i) => `id-${i}`)).length);
    }

    expect(lengths.size).toBe(10);
    expect([...lengths].sort((a, b) => a - b)).toEqual([1, 2, 4, 8, 16, 32, 64, 128, 256, 512]);
  });

  it("returns the same reference when no padding is needed", () => {
    const empty: string[] = [];
    const single = ["only"];
    const exact = ["a", "b", "c", "d"];

    expect(boundedIn(empty)).toBe(empty);
    expect(boundedIn(single)).toBe(single);
    expect(boundedIn(exact)).toBe(exact);
  });

  it("does not mutate the input", () => {
    const values = ["a", "b", "c"];

    boundedIn(values);

    expect(values).toEqual(["a", "b", "c"]);
  });

  it("leaves lists above the bind-parameter cap unchanged", () => {
    const huge = Array.from({ length: 40_000 }, (_, i) => i);

    expect(boundedIn(huge)).toBe(huge);
  });

  it("pads the largest list that still fits under the cap", () => {
    const values = Array.from({ length: 20_000 }, (_, i) => i);

    expect(boundedIn(values)).toHaveLength(32_768);
  });

  it("preserves the original values in order", () => {
    const padded = boundedIn(["x", "y", "z"]);

    expect(padded.slice(0, 3)).toEqual(["x", "y", "z"]);
  });
});
