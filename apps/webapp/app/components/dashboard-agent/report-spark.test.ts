import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { barTimesMs, condense, hotBarCount, MAX_BARS, seriesEndMs } from "./report-spark";

describe("condense", () => {
  it("leaves a series that already fits alone, by reference", () => {
    const points = [1, 2, 3];
    expect(condense(points, 18)).toBe(points);
  });

  it("averages adjacent points down to the bar count", () => {
    expect(condense([0, 2, 4, 6], 2)).toEqual([1, 5]);
  });

  it("covers every point exactly once", () => {
    const points = Array.from({ length: 97 }, (_, i) => i);
    const bars = condense(points, MAX_BARS);
    expect(bars).toHaveLength(MAX_BARS);
    // Each bar is a mean of a non-empty slice, so no bar is NaN and the whole
    // series is inside the bars' range.
    expect(bars.every((bar) => Number.isFinite(bar))).toBe(true);
    expect(Math.min(...bars)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...bars)).toBeLessThanOrEqual(96);
  });

  it("never asks for a slice ending before the first point", () => {
    // Why the removed `Math.max(end, 1)` was unreachable: past the early return
    // `perBar > 1`, so even the first bar's end index is already at least 1.
    for (let maxBars = 1; maxBars <= 30; maxBars++) {
      for (let length = maxBars + 1; length <= maxBars + 40; length++) {
        const perBar = length / maxBars;
        for (let i = 0; i < maxBars; i++) {
          expect(Math.floor((i + 1) * perBar)).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it("gives the first bar the first points, not a slice starting past them", () => {
    // The old `Math.max(end, 1)` claimed to guard an empty first slice. With
    // `points.length > maxBars` the end index is already at least 1, so the guard
    // never fired — and if it ever had, the first bar would be a single point.
    expect(condense([10, 20, 30, 40, 50, 60], 3)).toEqual([15, 35, 55]);
  });
});

describe("seriesEndMs", () => {
  it("reads the presenter's timestamp", () => {
    expect(seriesEndMs("2026-07-27T10:15:00.000Z")).toBe(Date.parse("2026-07-27T10:15:00.000Z"));
  });

  it("is null for a missing or unparseable timestamp", () => {
    expect(seriesEndMs(undefined)).toBeNull();
    expect(seriesEndMs("")).toBeNull();
    expect(seriesEndMs("not a date")).toBeNull();
  });
});

/**
 * The bars are the report's, not the reader's: two people opening the same report an hour apart,
 * and one reader re-rendering, must all see the same time on the same bar.
 */
describe("barTimesMs", () => {
  const end = Date.parse("2026-07-27T10:00:00.000Z");

  it("spreads the bars back from the series' end", () => {
    const times = barTimesMs(4, 60, end);
    expect(times).toEqual([
      Date.parse("2026-07-27T09:00:00.000Z"),
      Date.parse("2026-07-27T09:15:00.000Z"),
      Date.parse("2026-07-27T09:30:00.000Z"),
      Date.parse("2026-07-27T09:45:00.000Z"),
    ]);
  });

  it("returns the same times however long after the report they are asked for", () => {
    expect(barTimesMs(4, 60, end)).toEqual(barTimesMs(4, 60, end));
  });

  it("gives every bar no time at all when the end is unknown", () => {
    expect(barTimesMs(3, 60, null)).toEqual([null, null, null]);
  });

  it("has no bars to time when there are no bars", () => {
    expect(barTimesMs(0, 60, end)).toEqual([]);
  });
});

describe("hotBarCount", () => {
  it("is none without an anomaly window", () => {
    expect(hotBarCount(18, 60, undefined)).toBe(0);
  });

  it("marks the trailing bars the window covers", () => {
    expect(hotBarCount(12, 60, 15)).toBe(3);
  });

  it("marks at least one bar, and never more than there are", () => {
    expect(hotBarCount(12, 60, 1)).toBe(1);
    expect(hotBarCount(12, 60, 600)).toBe(12);
  });
});

/**
 * Structural guard, not behavioural proof: it asserts the renderer's source never reaches for a
 * clock, which is what keeps the bars above stable. It does not render the card.
 */
describe("the report card reads no clock", () => {
  const sources = ["report-sparkline.tsx", "ReportView.tsx"];

  it.each(sources)("%s calls neither Date.now nor new Date()", (file) => {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    expect(source).not.toMatch(/Date\.now\(\)/);
    expect(source).not.toMatch(/new Date\(\s*\)/);
  });
});
