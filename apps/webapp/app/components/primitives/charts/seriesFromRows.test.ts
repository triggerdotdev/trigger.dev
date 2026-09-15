import { describe, expect, it } from "vitest";
import { getSeriesColor } from "~/components/code/chartColors";
import { METRIC_X_KEY } from "./metricPoints";
import { MAX_SERIES, seriesFromRows } from "./seriesFromRows";
import { statusColor } from "./statusColors";

describe("seriesFromRows", () => {
  it("carries wide rows through, one series per y column", () => {
    const { points, series } = seriesFromRows(
      [
        { t: "2024-01-01 00:00:00", queued: 3, running: "1" },
        { t: "2024-01-01 00:01:00", queued: 0, running: 5 },
      ],
      { xAxisColumn: "t", yAxisColumns: ["queued", "running"] }
    );

    expect(points).toEqual([
      { [METRIC_X_KEY]: "2024-01-01 00:00:00", queued: 3, running: 1 },
      { [METRIC_X_KEY]: "2024-01-01 00:01:00", queued: 0, running: 5 },
    ]);
    expect(series).toEqual([
      { key: "queued", label: "queued", color: getSeriesColor(0) },
      { key: "running", label: "running", color: getSeriesColor(1) },
    ]);
  });

  it("pivots long-form rows into one series per group value and aggregates duplicates", () => {
    const { points, series } = seriesFromRows(
      [
        { t: 1, task: "a", count: 2 },
        { t: 1, task: "b", count: 4 },
        { t: 1, task: "a", count: 3 },
        { t: 2, task: "b", count: 1 },
      ],
      { xAxisColumn: "t", yAxisColumns: ["count"], groupByColumn: "task" }
    );

    expect(series.map((s) => s.key)).toEqual(["a", "b"]);
    expect(points).toEqual([
      { [METRIC_X_KEY]: 1, a: 5, b: 4 },
      // A group missing from a bucket is a zero, so a stack keeps its baseline.
      { [METRIC_X_KEY]: 2, a: 0, b: 1 },
    ]);
  });

  it("honours the aggregation", () => {
    const { points } = seriesFromRows(
      [
        { t: 1, count: 2 },
        { t: 1, count: 6 },
      ],
      { xAxisColumn: "t", yAxisColumns: ["count"], aggregation: "avg" }
    );

    expect(points).toEqual([{ [METRIC_X_KEY]: 1, count: 4 }]);
  });

  it("colours run-status group values with the status palette", () => {
    const { series } = seriesFromRows(
      [
        { t: 1, status: "COMPLETED", count: 1 },
        { t: 1, status: "FAILED", count: 2 },
        { t: 1, status: "not-a-status", count: 3 },
      ],
      { xAxisColumn: "t", yAxisColumns: ["count"], groupByColumn: "status" }
    );

    expect(series.map((s) => s.color)).toEqual([
      statusColor("COMPLETED"),
      statusColor("FAILED"),
      getSeriesColor(2),
    ]);
  });

  it("orders group values the same way whatever order the rows arrive in", () => {
    const rows = [
      { t: 1, status: "zeta", count: 1 },
      { t: 1, status: "FAILED", count: 1 },
      { t: 1, status: "alpha", count: 1 },
      { t: 1, status: "COMPLETED", count: 1 },
    ];
    const config = { xAxisColumn: "t", yAxisColumns: ["count"], groupByColumn: "status" };

    const keys = seriesFromRows(rows, config).series.map((s) => s.key);
    const shuffled = seriesFromRows([...rows].reverse(), config).series.map((s) => s.key);

    expect(keys).toEqual(["COMPLETED", "FAILED", "alpha", "zeta"]);
    expect(shuffled).toEqual(keys);
  });

  it("caps the group values at MAX_SERIES, keeping the largest", () => {
    const rows = Array.from({ length: MAX_SERIES + 5 }, (_, i) => ({
      t: 1,
      group: `g${i}`,
      count: i,
    }));

    const { series, points } = seriesFromRows(rows, {
      xAxisColumn: "t",
      yAxisColumns: ["count"],
      groupByColumn: "group",
    });

    expect(series).toHaveLength(MAX_SERIES);
    // The five smallest totals are dropped.
    expect(series.map((s) => s.key)).not.toContain("g0");
    expect(series.map((s) => s.key)).toContain(`g${MAX_SERIES + 4}`);
    expect(Object.keys(points[0]!)).toHaveLength(MAX_SERIES + 1);
  });

  it("returns nothing for empty rows", () => {
    expect(seriesFromRows([], { xAxisColumn: "t", yAxisColumns: ["count"] })).toEqual({
      points: [],
      series: [],
      totalSeriesCount: 0,
    });
  });
  it("keeps a point for an x whose only y is null", () => {
    const { points } = seriesFromRows(
      [
        { t: 1, count: 5 },
        { t: 2, count: null },
        { t: 3, count: 7 },
      ],
      { xAxisColumn: "t", yAxisColumns: ["count"] }
    );

    expect(points).toEqual([
      { [METRIC_X_KEY]: 1, count: 5 },
      { [METRIC_X_KEY]: 2, count: null },
      { [METRIC_X_KEY]: 3, count: 7 },
    ]);
  });

  it("reports how many groups there were before the cap", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ t: 1, group: `g${i}`, count: i + 1 }));

    const { series, totalSeriesCount } = seriesFromRows(rows, {
      xAxisColumn: "t",
      yAxisColumns: ["count"],
      groupByColumn: "group",
    });

    expect(totalSeriesCount).toBe(60);
    expect(series).toHaveLength(MAX_SERIES);
  });

  it("keeps the coordinate when a group is named after the x column", () => {
    const { points, series } = seriesFromRows(
      [
        { t: 1, group: "t", count: 3 },
        { t: 1, group: "other", count: 4 },
      ],
      { xAxisColumn: "t", yAxisColumns: ["count"], groupByColumn: "group" }
    );

    expect(series.map((s) => s.key)).toEqual(["other", "t"]);
    expect(points).toEqual([{ [METRIC_X_KEY]: 1, t: 3, other: 4 }]);
  });
  it("tells a null group value apart from an absent group", () => {
    const { points } = seriesFromRows(
      [
        { t: 1, group: "a", count: 5 },
        { t: 1, group: "b", count: 2 },
        { t: 2, group: "a", count: null },
      ],
      { xAxisColumn: "t", yAxisColumns: ["count"], groupByColumn: "group" }
    );

    expect(points).toEqual([
      { [METRIC_X_KEY]: 1, a: 5, b: 2 },
      // "a" reported null here (a gap); "b" simply wasn't in the bucket (a zero).
      { [METRIC_X_KEY]: 2, a: null, b: 0 },
    ]);
  });
});
