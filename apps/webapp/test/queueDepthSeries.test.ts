import { describe, expect, it } from "vitest";
import { queueDepthSeries } from "~/v3/queueDepthSeries";

const BUCKET_MS = 300_000;
const START_MS = Date.parse("2026-01-01T00:00:00Z");

function bucketAt(index: number): string {
  return new Date(START_MS + index * BUCKET_MS).toISOString().slice(0, 19).replace("T", " ");
}

function row(index: number, depth: number, throttled = 0) {
  return { bucket: bucketAt(index), depth, throttled };
}

const grid = { startMs: START_MS, bucketIntervalMs: BUCKET_MS, numBuckets: 6 };

describe("queueDepthSeries", () => {
  it("keeps later points in place when a bucket in the middle has no sample", () => {
    // Buckets 2 and 3 never reported; 4 and 5 must stay at index 4 and 5.
    const series = queueDepthSeries([row(0, 10), row(1, 20), row(4, 90), row(5, 95)], grid);

    expect(series.depth).toEqual([10, 20, 20, 20, 90, 95]);
  });

  it("emits one point per bucket regardless of how many rows came back", () => {
    expect(queueDepthSeries([row(3, 7)], grid).depth).toHaveLength(6);
    expect(queueDepthSeries([], grid).depth).toHaveLength(6);
  });

  it("carries the previous depth across a gap rather than dropping to zero", () => {
    expect(queueDepthSeries([row(0, 42)], grid).depth).toEqual([42, 42, 42, 42, 42, 42]);
  });

  it("starts at zero until the first sample", () => {
    expect(queueDepthSeries([row(2, 5)], grid).depth).toEqual([0, 0, 5, 5, 5, 5]);
  });

  it("orders points oldest first whatever order the rows arrive in", () => {
    expect(queueDepthSeries([row(5, 95), row(0, 10), row(2, 30)], grid).depth).toEqual([
      10, 10, 30, 30, 30, 95,
    ]);
  });

  it("does not carry throttled counts across a gap", () => {
    expect(queueDepthSeries([row(0, 10, 4), row(3, 20, 1)], grid).throttled).toEqual([
      4, 0, 0, 1, 0, 0,
    ]);
  });

  it("drops rows outside the grid and unparseable buckets", () => {
    const series = queueDepthSeries(
      [row(-1, 999), row(6, 999), { bucket: "not-a-date", depth: 999, throttled: 0 }, row(1, 8)],
      grid
    );

    expect(series.depth).toEqual([0, 8, 8, 8, 8, 8]);
  });
});
