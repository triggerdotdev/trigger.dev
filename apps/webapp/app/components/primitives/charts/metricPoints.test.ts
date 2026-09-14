import { describe, expect, it } from "vitest";
import { buildMetricPoints, METRIC_X_KEY } from "./metricPoints";

const series = [{ key: "count", label: "count", color: "#fff" }];

describe("buildMetricPoints", () => {
  it("plots one point per category when the x values are not timestamps", () => {
    const { points, xKind } = buildMetricPoints(
      [
        { status: "COMPLETED", count: 4 },
        { status: "FAILED", count: 1 },
        { status: "CANCELED", count: 0 },
      ],
      { series, xColumn: "status" }
    );

    expect(xKind).toBe("category");
    expect(points).toEqual([
      { [METRIC_X_KEY]: "COMPLETED", count: 4 },
      { [METRIC_X_KEY]: "FAILED", count: 1 },
      { [METRIC_X_KEY]: "CANCELED", count: 0 },
    ]);
  });

  it("sorts time points ascending however the rows arrive", () => {
    const { points } = buildMetricPoints(
      [
        { t: "2026-09-09 21:47:00", count: 3 },
        { t: "2026-09-09 21:45:00", count: 1 },
        { t: "2026-09-09 21:46:00", count: 2 },
      ],
      { series }
    );

    expect(points.map((p) => p.count)).toEqual([1, 2, 3]);
    expect(points.map((p) => p[METRIC_X_KEY])).toEqual([
      Date.parse("2026-09-09T21:45:00Z"),
      Date.parse("2026-09-09T21:46:00Z"),
      Date.parse("2026-09-09T21:47:00Z"),
    ]);
  });

  it("keeps the row order on a categorical axis", () => {
    const { points } = buildMetricPoints(
      [
        { status: "FAILED", count: 1 },
        { status: "COMPLETED", count: 2 },
        { status: "CANCELED", count: 3 },
      ],
      { series, xColumn: "status" }
    );

    expect(points.map((p) => p[METRIC_X_KEY])).toEqual(["FAILED", "COMPLETED", "CANCELED"]);
  });

  it("keeps numeric-looking labels categorical", () => {
    for (const label of ["200", "404", "2024", "1", "42"]) {
      const { xKind, points } = buildMetricPoints([{ status: label, count: 1 }], {
        series,
        xColumn: "status",
      });
      expect(xKind, label).toBe("category");
      expect(points[0]![METRIC_X_KEY]).toBe(label);
    }
  });

  it("reads datetime strings and epoch numbers as a time axis", () => {
    const cases: Array<[unknown, number]> = [
      ["2026-09-09 21:45:00", Date.parse("2026-09-09T21:45:00Z")],
      ["2026-09-09T21:45:00Z", Date.parse("2026-09-09T21:45:00Z")],
      ["2026-09-09T21:45:00.500Z", Date.parse("2026-09-09T21:45:00.500Z")],
      ["2026-09-09", Date.parse("2026-09-09")],
      [1_700_000_000_000, 1_700_000_000_000],
      // Epoch seconds are scaled up to milliseconds.
      [1_700_000_000, 1_700_000_000_000],
    ];

    for (const [x, expected] of cases) {
      const { xKind, points } = buildMetricPoints([{ t: x, count: 1 }], { series });
      expect(xKind, String(x)).toBe("time");
      expect(points[0]![METRIC_X_KEY], String(x)).toBe(expected);
    }
  });

  it("parses ClickHouse timestamps into a time axis", () => {
    const { points, xKind } = buildMetricPoints([{ t: "2024-01-01 00:00:00", count: 2 }], {
      series,
    });

    expect(xKind).toBe("time");
    expect(points).toEqual([{ [METRIC_X_KEY]: Date.parse("2024-01-01T00:00:00Z"), count: 2 }]);
  });

  it("drops unparseable x values on a time axis only", () => {
    expect(buildMetricPoints([{ t: "nope", count: 1 }], { series, xKind: "time" }).points).toEqual(
      []
    );
    expect(
      buildMetricPoints([{ t: "nope", count: 1 }], { series, xKind: "category" }).points
    ).toEqual([{ [METRIC_X_KEY]: "nope", count: 1 }]);
  });

  it("breaks every series where the sample count is zero", () => {
    const { points } = buildMetricPoints(
      [
        { t: 1_700_000_000_000, count: 0, samples: 0 },
        { t: 1_700_000_060_000, count: 5, samples: 3 },
      ],
      { series, sampleCountColumn: "samples" }
    );

    expect(points).toEqual([
      { [METRIC_X_KEY]: 1_700_000_000_000, count: null },
      { [METRIC_X_KEY]: 1_700_000_060_000, count: 5 },
    ]);
  });

  it("carries the first real value back over leading zeros", () => {
    const { points } = buildMetricPoints(
      [
        { t: 1, count: 0 },
        { t: 2, count: 0 },
        { t: 3, count: 7 },
      ],
      { series, carryBackfill: ["count"] }
    );

    expect(points.map((p) => p.count)).toEqual([7, 7, 7]);
  });
  it("keeps the coordinate when a series is named after it", () => {
    const { points } = buildMetricPoints([{ t: 1_700_000_000_000, bucket: 3 }], {
      series: [{ key: "bucket", label: "bucket", color: "#fff" }],
    });

    expect(points).toEqual([{ [METRIC_X_KEY]: 1_700_000_000_000, bucket: 3 }]);
  });

  it("reads a null y as a gap, not a zero", () => {
    const { points } = buildMetricPoints(
      [
        { t: 1_700_000_000_000, count: 1 },
        { t: 1_700_000_060_000, count: null },
        { t: 1_700_000_120_000, count: undefined },
      ],
      { series }
    );

    expect(points.map((p) => p.count)).toEqual([1, null, null]);
  });
});
