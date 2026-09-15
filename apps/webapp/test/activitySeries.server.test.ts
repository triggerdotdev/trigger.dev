import { describe, expect, it } from "vitest";
import {
  chooseBucketSeconds,
  groupRunStatus,
  RUN_STATUS_GROUPS,
  zeroFillGroupedSeries,
  zeroFillScalarSeries,
} from "~/presenters/v3/activitySeries.server";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("chooseBucketSeconds", () => {
  it("uses fine buckets for sub-hour ranges (the 5-minute bug)", () => {
    // 5 minutes should NOT collapse to a single 1h bar.
    expect(chooseBucketSeconds(5 * MINUTE)).toBe(5); // 60 buckets
    expect(chooseBucketSeconds(1 * MINUTE)).toBe(1); // 60 buckets
    expect(chooseBucketSeconds(30 * MINUTE)).toBe(30); // 60 buckets
  });

  it("scales the interval up for longer ranges", () => {
    expect(chooseBucketSeconds(1 * HOUR)).toBe(60);
    expect(chooseBucketSeconds(6 * HOUR)).toBe(300);
    expect(chooseBucketSeconds(7 * DAY)).toBe(7200);
    expect(chooseBucketSeconds(30 * DAY)).toBe(43200);
  });

  it("never exceeds the bucket ceiling", () => {
    const ranges = [1 * MINUTE, 5 * MINUTE, 1 * HOUR, 24 * HOUR, 7 * DAY, 30 * DAY];
    for (const range of ranges) {
      const secs = chooseBucketSeconds(range);
      const count = range / 1000 / secs;
      expect(count).toBeLessThanOrEqual(120);
      expect(count).toBeGreaterThan(0);
    }
  });

  it("falls back to a computed interval for ranges beyond the ladder", () => {
    const huge = 2000 * DAY;
    const secs = chooseBucketSeconds(huge);
    const count = huge / 1000 / secs;
    expect(count).toBeLessThanOrEqual(120);
  });

  it("honours a custom target", () => {
    // Smaller target => wider buckets => fewer bars.
    const wide = chooseBucketSeconds(1 * HOUR, { targetBuckets: 12 });
    const dense = chooseBucketSeconds(1 * HOUR, { targetBuckets: 72 });
    expect(wide).toBeGreaterThan(dense);
  });
});

describe("groupRunStatus", () => {
  it("maps raw statuses to chart groups", () => {
    expect(groupRunStatus("COMPLETED_SUCCESSFULLY")).toBe("COMPLETED");
    expect(groupRunStatus("CRASHED")).toBe("FAILED");
    expect(groupRunStatus("EXPIRED")).toBe("CANCELED");
    expect(groupRunStatus("EXECUTING")).toBe("RUNNING");
    expect(groupRunStatus("SOMETHING_UNKNOWN")).toBeUndefined();
  });
});

describe("zeroFillGroupedSeries", () => {
  it("emits a contiguous, fully zero-filled series", () => {
    const from = new Date("2026-06-22T00:00:00.000Z");
    const to = new Date("2026-06-22T00:00:05.000Z"); // 5 seconds
    const bucketSeconds = 1;
    const at2s = Math.floor(new Date("2026-06-22T00:00:02.000Z").getTime() / 1000);

    const points = zeroFillGroupedSeries({
      rows: [{ bucket: at2s, status: "COMPLETED_SUCCESSFULLY", val: 3 }],
      from,
      to,
      bucketSeconds,
      orderedKeys: RUN_STATUS_GROUPS,
      groupFn: groupRunStatus,
      fallbackKey: "RUNNING",
    });

    expect(points).toHaveLength(5);
    // Every point has every key (stable legend).
    for (const p of points) {
      for (const key of RUN_STATUS_GROUPS) {
        expect(typeof p[key]).toBe("number");
      }
    }
    // The matching bucket carries the value; the rest are zero.
    const filled = points.find((p) => p.bucket === at2s * 1000);
    expect(filled?.COMPLETED).toBe(3);
    expect(points.filter((p) => p.COMPLETED > 0)).toHaveLength(1);
  });

  it("uses identity grouping when no groupFn is provided", () => {
    const from = new Date("2026-06-22T00:00:00.000Z");
    const to = new Date("2026-06-22T00:00:02.000Z");
    const at0 = Math.floor(from.getTime() / 1000);

    const points = zeroFillGroupedSeries({
      rows: [{ bucket: at0, status: "ACTIVE", val: 7 }],
      from,
      to,
      bucketSeconds: 1,
      orderedKeys: ["ACTIVE", "CLOSED", "EXPIRED"] as const,
    });

    expect(points).toHaveLength(2);
    expect(points[0].ACTIVE).toBe(7);
    expect(points[0].CLOSED).toBe(0);
  });
});

describe("zeroFillScalarSeries", () => {
  it("zero-fills a single series", () => {
    const from = new Date("2026-06-22T00:00:00.000Z");
    const to = new Date("2026-06-22T00:00:03.000Z");
    const at1 = Math.floor(new Date("2026-06-22T00:00:01.000Z").getTime() / 1000);

    const points = zeroFillScalarSeries({
      rows: [{ bucket: at1, val: 42 }],
      from,
      to,
      bucketSeconds: 1,
      seriesKey: "cost",
    });

    expect(points).toHaveLength(3);
    expect(points.find((p) => p.bucket === at1 * 1000)?.cost).toBe(42);
    expect(points.filter((p) => p.cost > 0)).toHaveLength(1);
  });
});
