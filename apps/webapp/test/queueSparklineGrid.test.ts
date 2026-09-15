import { describe, expect, it } from "vitest";
import { bucketIndex, computeSparklineGrid, SPARKLINE_POINTS } from "~/v3/queueSparklineGrid";

const PERIODS_MS = {
  "30m": 30 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

/** Newest bucket the ClickHouse query can return: the last full slot before the grid end. */
function newestBucketMs(grid: ReturnType<typeof computeSparklineGrid>): number {
  return grid.endMs - grid.bucketIntervalMs;
}

describe("computeSparklineGrid", () => {
  it("keeps the newest bucket for every period, at any start offset", () => {
    for (const [label, span] of Object.entries(PERIODS_MS)) {
      for (let offset = 0; offset < 120; offset++) {
        const toMs = 1785000000000 + offset * 1371;
        const grid = computeSparklineGrid(new Date(toMs - span), new Date(toMs));

        expect(
          bucketIndex(grid, newestBucketMs(grid)),
          `${label} dropped its newest bucket at offset ${offset}`
        ).not.toBeNull();
      }
    }
  });

  it("indexes every bucket the query can return, and nothing outside the grid", () => {
    const toMs = 1785000000123;
    const grid = computeSparklineGrid(new Date(toMs - PERIODS_MS["1d"]), new Date(toMs));

    expect(bucketIndex(grid, grid.bucketStartMs)).toBe(0);
    expect(bucketIndex(grid, newestBucketMs(grid))).toBe(grid.bucketCount - 1);
    expect(bucketIndex(grid, grid.bucketStartMs - grid.bucketIntervalMs)).toBeNull();
    expect(bucketIndex(grid, grid.endMs)).toBeNull();
  });

  it("aligns the grid outward from the requested range", () => {
    const from = new Date(1785000000123);
    const to = new Date(from.getTime() + PERIODS_MS["1h"]);
    const grid = computeSparklineGrid(from, to);

    expect(grid.bucketStartMs).toBeLessThanOrEqual(from.getTime());
    expect(grid.endMs).toBeGreaterThanOrEqual(to.getTime());
    expect(grid.bucketStartMs % grid.bucketIntervalMs).toBe(0);
    expect(grid.endMs % grid.bucketIntervalMs).toBe(0);
  });

  it("targets the sparkline resolution without going below a one minute bucket", () => {
    const toMs = 1785000000000;
    const dayGrid = computeSparklineGrid(new Date(toMs - PERIODS_MS["1d"]), new Date(toMs));
    expect(dayGrid.bucketSeconds).toBe(1800);
    expect(dayGrid.bucketCount).toBeGreaterThanOrEqual(SPARKLINE_POINTS);

    const shortGrid = computeSparklineGrid(new Date(toMs - 60_000), new Date(toMs));
    expect(shortGrid.bucketSeconds).toBe(60);
    expect(shortGrid.bucketCount).toBeGreaterThanOrEqual(1);
  });

  it("never returns a zero-bucket grid for a degenerate range", () => {
    const at = new Date(1785000000000);
    const grid = computeSparklineGrid(at, at);
    expect(grid.bucketCount).toBeGreaterThanOrEqual(1);
    expect(grid.bucketSeconds).toBe(60);
  });
});
