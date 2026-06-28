import { describe, expect, it } from "vitest";
import {
  dedupeTicksByLabel,
  estimateMaxLabels,
  selectEvenlySpacedIndices,
  selectEvenlySpacedTicks,
} from "~/components/primitives/charts/useXAxisTicks";

describe("selectEvenlySpacedTicks", () => {
  const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

  it("always includes first and last", () => {
    const ticks = selectEvenlySpacedTicks(values, 4);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(9);
  });

  it("spaces ticks evenly", () => {
    expect(selectEvenlySpacedTicks(values, 4)).toEqual([0, 3, 6, 9]);
  });

  it("returns all values when more labels than points are allowed", () => {
    expect(selectEvenlySpacedTicks(values, 50)).toEqual(values);
  });

  it("returns just the endpoints for 2 labels", () => {
    expect(selectEvenlySpacedTicks(values, 2)).toEqual([0, 9]);
  });

  it("returns a single value for 1 label", () => {
    expect(selectEvenlySpacedTicks(values, 1)).toEqual([0]);
  });

  it("handles empty input", () => {
    expect(selectEvenlySpacedTicks([], 5)).toEqual([]);
  });

  it("never produces duplicates", () => {
    const ticks = selectEvenlySpacedTicks([0, 1, 2], 3);
    expect(new Set(ticks).size).toBe(ticks.length);
  });
});

describe("selectEvenlySpacedIndices", () => {
  it("includes first and last, evenly spaced", () => {
    expect(selectEvenlySpacedIndices(10, 4)).toEqual([0, 3, 6, 9]);
  });

  it("returns all indices when count >= n", () => {
    expect(selectEvenlySpacedIndices(3, 10)).toEqual([0, 1, 2]);
  });

  it("returns endpoints for count 2", () => {
    expect(selectEvenlySpacedIndices(50, 2)).toEqual([0, 49]);
  });

  it("returns [0] for count <= 1", () => {
    expect(selectEvenlySpacedIndices(50, 1)).toEqual([0]);
  });

  it("handles empty range", () => {
    expect(selectEvenlySpacedIndices(0, 5)).toEqual([]);
  });

  it("always ends at the last index (partial-period start stays even)", () => {
    // 74 buckets, room for ~8 labels -> evenly spaced, last index present
    const idx = selectEvenlySpacedIndices(74, 8);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(73);
    // gaps are roughly uniform (no tiny first gap)
    const gaps = idx.slice(1).map((v, i) => v - idx[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(9);
  });
});

describe("estimateMaxLabels", () => {
  it("returns 0 when width is unknown", () => {
    expect(estimateMaxLabels(0, 5)).toBe(0);
  });

  it("fits more labels in a wider chart", () => {
    const narrow = estimateMaxLabels(200, 5);
    const wide = estimateMaxLabels(800, 5);
    expect(wide).toBeGreaterThan(narrow);
  });

  it("fits fewer labels when labels are wider", () => {
    const shortLabels = estimateMaxLabels(400, 5);
    const longLabels = estimateMaxLabels(400, 12);
    expect(longLabels).toBeLessThanOrEqual(shortLabels);
  });

  it("always allows at least one label for a positive width", () => {
    expect(estimateMaxLabels(10, 100)).toBeGreaterThanOrEqual(1);
  });
});

describe("dedupeTicksByLabel", () => {
  it("drops adjacent duplicate labels", () => {
    const labels = ["A", "A", "B", "B", "C"];
    const values = [0, 1, 2, 3, 4];
    expect(dedupeTicksByLabel([0, 1, 2, 3, 4], labels, values)).toEqual([0, 2, 4]);
  });

  it("keeps the last index when its label repeats the previous tick (first+last contract)", () => {
    // indices 6 and 9 render the same label; the naive loop would drop index 9
    // and leave the right edge unlabeled. The last index must win.
    const labels = ["a", "b", "c", "d", "e", "f", "X", "g", "h", "X"];
    const values = labels.map((_, i) => i);
    const ticks = dedupeTicksByLabel([0, 3, 6, 9], labels, values);
    expect(ticks[ticks.length - 1]).toBe(9);
    expect(ticks).toEqual([0, 3, 9]);
  });

  it("leaves already-unique labels untouched", () => {
    const labels = ["Jan", "Feb", "Mar"];
    const values = ["Jan", "Feb", "Mar"];
    expect(dedupeTicksByLabel([0, 1, 2], labels, values)).toEqual(["Jan", "Feb", "Mar"]);
  });

  it("handles an empty selection", () => {
    expect(dedupeTicksByLabel([], [], [])).toEqual([]);
  });
});
