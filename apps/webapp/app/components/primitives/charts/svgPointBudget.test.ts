import { describe, expect, it } from "vitest";
import { METRIC_X_KEY, type MetricChartRow } from "./metricPoints";
import {
  downsamplePoints,
  MAX_SVG_ELEMENT_BUDGET,
  maxPointsForSeries,
  orderPointsByTime,
} from "./svgPointBudget";

function bucketRows(count: number, seriesCount: number): MetricChartRow[] {
  return Array.from({ length: count }, (_, i) => {
    const row: MetricChartRow = { [METRIC_X_KEY]: i };
    for (let s = 0; s < seriesCount; s++) row[`series-${s}`] = 1;
    return row;
  });
}

const EPOCH_BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

/** Real epoch-ms timestamps (unlike `bucketRows`' bare index), so `timeValueMs` recognizes them. */
function timeBucketRows(count: number): MetricChartRow[] {
  return Array.from({ length: count }, (_, i) => ({
    [METRIC_X_KEY]: EPOCH_BASE_MS + i * 60_000,
    "series-0": i,
  }));
}

describe("svgPointBudget", () => {
  it("downsamples 10,000 buckets x 50 series to within the SVG budget, keeping first/last and order", () => {
    const seriesCount = 50;
    const rows = bucketRows(10_000, seriesCount);
    const seriesKeys = Array.from({ length: seriesCount }, (_, s) => `series-${s}`);

    const maxPoints = maxPointsForSeries(seriesCount);
    const result = downsamplePoints(rows, maxPoints, seriesKeys, "sum");

    expect(result.length * seriesCount).toBeLessThanOrEqual(MAX_SVG_ELEMENT_BUDGET);
    expect(result[0]![METRIC_X_KEY]).toBe(rows[0]![METRIC_X_KEY]);
    expect(result[result.length - 1]![METRIC_X_KEY]).toBe(rows[rows.length - 1]![METRIC_X_KEY]);
    const xs = result.map((r) => r[METRIC_X_KEY] as number);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("preserves a spike in the middle instead of averaging it away", () => {
    const rows = bucketRows(1000, 1);
    // A single huge spike between the otherwise-1-valued buckets: stride sampling would very
    // likely land its samples elsewhere and lose it entirely.
    rows[503]!["series-0"] = 100_000;

    const result = downsamplePoints(rows, 50, ["series-0"], "max");

    const max = Math.max(...result.map((r) => r["series-0"] as number));
    expect(max).toBe(100_000);
  });

  it("preserves the sum total across buckets for sum aggregation", () => {
    const rows = bucketRows(997, 1); // not evenly divisible by the bucket count

    const result = downsamplePoints(rows, 50, ["series-0"], "sum");

    const total = result.reduce((acc, r) => acc + (r["series-0"] as number), 0);
    expect(total).toBe(997);
  });

  it("orders shuffled-time points chronologically before downsampling", () => {
    const sorted = timeBucketRows(600);
    const shuffled = [...sorted].reverse();

    const fromSorted = downsamplePoints(orderPointsByTime(sorted), 50, ["series-0"], "sum");
    const fromShuffled = downsamplePoints(orderPointsByTime(shuffled), 50, ["series-0"], "sum");

    expect(fromShuffled).toEqual(fromSorted);
    // Each bucket's timestamps stay adjacent from the sorted input, not scattered pairs from the
    // shuffle — this is what breaks if the pre-sort is skipped.
    const xs = fromShuffled.map((r) => r[METRIC_X_KEY] as number);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("leaves categorical x untouched when ordering by time", () => {
    const rows: MetricChartRow[] = [
      { [METRIC_X_KEY]: "b" },
      { [METRIC_X_KEY]: "a" },
      { [METRIC_X_KEY]: "c" },
    ];

    expect(orderPointsByTime(rows)).toBe(rows);
  });

  it("passes a small series through unchanged", () => {
    const rows = bucketRows(20, 3);
    const seriesKeys = ["series-0", "series-1", "series-2"];

    const result = downsamplePoints(rows, maxPointsForSeries(3), seriesKeys, "sum");

    expect(result).toBe(rows);
    expect(result).toHaveLength(20);
  });
});
