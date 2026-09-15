import type { AggregationType } from "~/components/metrics/QueryWidget";
import { aggregateValues } from "./aggregation";
import { METRIC_X_KEY, timeValueMs, type MetricChartRow } from "./metricPoints";

/**
 * SVG element budget for chart rendering: past this many plotted elements (points × series)
 * Recharts stops being readable or fast. Downsampling buckets consecutive points and aggregates
 * them down to this budget, rather than dropping points, so a spike between two kept points
 * doesn't silently disappear.
 */
export const MAX_SVG_ELEMENT_BUDGET = 6_000;
const MIN_DATA_POINTS = 100;
const MAX_DATA_POINTS = 500;

/** Point budget for a given series count, clamped to [MIN_DATA_POINTS, MAX_DATA_POINTS]. */
export function maxPointsForSeries(seriesCount: number): number {
  const denom = Math.max(1, seriesCount);
  return Math.max(
    MIN_DATA_POINTS,
    Math.min(MAX_DATA_POINTS, Math.floor(MAX_SVG_ELEMENT_BUDGET / denom))
  );
}

/**
 * Chronologically orders points whose x is a datetime, using the same parsing MetricChart
 * resolves the time axis with (`timeValueMs`) — so this can't disagree with what the axis itself
 * considers "time". A response can arrive in any order (e.g. an unordered GROUP BY); downsampling
 * before ordering would bucket-aggregate unrelated timestamps together. Categorical x (or a mix
 * of parseable/unparseable values) is left as-is, matching `buildMetricPoints`' own kind check.
 */
export function orderPointsByTime(points: MetricChartRow[]): MetricChartRow[] {
  const times = points.map((p) => timeValueMs(p[METRIC_X_KEY]));
  if (times.some((t) => t === undefined)) return points;

  return points
    .map((p, i) => ({ p, t: times[i]! }))
    .sort((a, b) => a.t - b.t)
    .map(({ p }) => p);
}

// "count" values are per-bucket totals already, so re-bucketing combines them with `sum` (the
// combined count of the merged buckets). Every other aggregation combines with itself: `sum` of
// sums is still the true sum, `min`/`max` of mins/maxes is still the true min/max, and `avg` of
// averages is a reasonable approximation of the mean without re-reading the raw samples.
function combiningAggregation(aggregation: AggregationType): AggregationType {
  return aggregation === "count" ? "sum" : aggregation;
}

/**
 * Downsamples to `maxPoints` by grouping consecutive points into that many buckets and
 * aggregating each series within a bucket — never dropping points outright, so a spike between
 * two kept points still shows up. The first bucket's x is the original first point's x and the
 * last bucket's x is the original last point's x, exactly; order is preserved throughout.
 */
export function downsamplePoints(
  points: MetricChartRow[],
  maxPoints: number,
  seriesKeys: string[],
  aggregation: AggregationType
): MetricChartRow[] {
  if (maxPoints <= 0 || points.length <= maxPoints) return points;

  const aggregationForBucket = combiningAggregation(aggregation);
  const bucketCount = maxPoints;
  const bucketSize = points.length / bucketCount;
  const result: MetricChartRow[] = [];

  for (let i = 0; i < bucketCount; i++) {
    const start = Math.floor(i * bucketSize);
    const end = i === bucketCount - 1 ? points.length : Math.floor((i + 1) * bucketSize);
    const bucketPoints = points.slice(start, end);
    if (bucketPoints.length === 0) continue;

    const x =
      i === 0
        ? points[0]![METRIC_X_KEY]
        : i === bucketCount - 1
          ? points[points.length - 1]![METRIC_X_KEY]
          : bucketPoints[0]![METRIC_X_KEY];

    const row: MetricChartRow = { [METRIC_X_KEY]: x };
    for (const key of seriesKeys) {
      const values: number[] = [];
      for (const p of bucketPoints) {
        const v = p[key];
        if (v !== null && v !== undefined) values.push(Number(v));
      }
      row[key] = values.length > 0 ? aggregateValues(values, aggregationForBucket) : null;
    }
    result.push(row);
  }

  return result;
}
