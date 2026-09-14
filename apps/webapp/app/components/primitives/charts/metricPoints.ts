export type MetricSeriesConfig = { key: string; label: string; color: string };

export type MetricChartRow = Record<string, unknown>;

/**
 * Reserved key the x coordinate is stored under, so a series or group named after the x column
 * (e.g. "bucket", "status") can't overwrite it. MetricChart maps it to the axis dataKey.
 */
export const METRIC_X_KEY = "__x";

/** Chart point. `__x` is a timestamp on a time axis, or the raw label on a categorical one. */
export type MetricPoint = { __x: number | string } & Record<string, number | string | null>;

export type MetricXKind = "time" | "category";

export function toNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** ClickHouse `DateTime` values arrive space-separated and zone-less; numbers pass through. */
export function toTimestampMs(value: unknown): number {
  if (typeof value === "number") return value;
  const s = String(value).replace(" ", "T");
  return Date.parse(s.endsWith("Z") ? s : `${s}Z`);
}

// Only these shapes count as a time value: a bare number like 200 or 2024 is a category label,
// but Date.parse("2024Z") happily reads it as a year.
const DATETIME_SHAPE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const ZONE_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/;
const EPOCH_MS_MIN = 1e11;
const EPOCH_SECONDS_MIN = 1e9;

/** The timestamp behind an x value, or undefined for anything that is a category label. */
export function timeValueMs(value: unknown): number | undefined {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
  }
  if (typeof value === "number") {
    const abs = Math.abs(value);
    if (!Number.isFinite(value) || abs < EPOCH_SECONDS_MIN) return undefined;
    // Epoch seconds and epoch milliseconds both appear in query results.
    return abs >= EPOCH_MS_MIN ? value : value * 1000;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!DATETIME_SHAPE.test(trimmed)) return undefined;
  const iso = trimmed.replace(" ", "T");
  const ms = Date.parse(iso.includes("T") && !ZONE_SUFFIX.test(iso) ? `${iso}Z` : iso);
  return Number.isFinite(ms) ? ms : undefined;
}

export type BuildMetricPointsOptions = {
  series: MetricSeriesConfig[];
  xColumn?: string;
  /** Defaults to `time` when every x is a datetime or epoch number, `category` otherwise. */
  xKind?: MetricXKind;
  carryBackfill?: string[];
  sampleCountColumn?: string;
};

export function buildMetricPoints(
  rows: MetricChartRow[],
  { series, xColumn = "t", xKind, carryBackfill, sampleCountColumn }: BuildMetricPointsOptions
): { points: MetricPoint[]; xKind: MetricXKind } {
  // Rows built by seriesFromRows already carry the coordinate under the reserved key.
  const xOf = (row: MetricChartRow) => (METRIC_X_KEY in row ? row[METRIC_X_KEY] : row[xColumn]);

  const kind =
    xKind ??
    (rows.length > 0 && rows.every((r) => timeValueMs(xOf(r)) !== undefined) ? "time" : "category");

  let points = rows.map((r) => {
    const point: MetricPoint = { [METRIC_X_KEY]: "" };
    const hasSamples = sampleCountColumn ? toNumber(r[sampleCountColumn]) > 0 : true;
    for (const s of series) {
      const value = r[s.key];
      // A bucket with no value for this series is a gap, not a zero.
      point[s.key] = hasSamples && value != null ? toNumber(value) : null;
    }
    // Set last, so a series key colliding with the reserved key can't displace the coordinate.
    point[METRIC_X_KEY] = kind === "time" ? (timeValueMs(xOf(r)) ?? NaN) : String(xOf(r) ?? "");
    return point;
  });

  if (kind === "time") {
    // A GROUP BY can return buckets in any order, and the x axis is drawn in array order.
    points = points
      .filter((p) => Number.isFinite(p[METRIC_X_KEY]))
      .sort((a, b) => (a[METRIC_X_KEY] as number) - (b[METRIC_X_KEY] as number));
  }

  // Back-fill leading zeros for config gauges (see `carryBackfill`): find the first positive
  // value and carry it back over the earlier buckets so the line doesn't start at a false 0.
  if (carryBackfill?.length) {
    for (const key of carryBackfill) {
      const first = points.findIndex((p) => toNumber(p[key]) > 0);
      if (first > 0) {
        const value = points[first]![key]!;
        for (let i = 0; i < first; i++) points[i]![key] = value;
      }
    }
  }

  return { points, xKind: kind };
}
