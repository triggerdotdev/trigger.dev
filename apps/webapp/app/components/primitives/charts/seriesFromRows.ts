import { getSeriesColor } from "~/components/code/chartColors";
import type { AggregationType } from "~/components/metrics/QueryWidget";
import { aggregateValues } from "./aggregation";
import { METRIC_X_KEY, type MetricChartRow, type MetricSeriesConfig } from "./metricPoints";
import { knownStatusColor, statusOrderIndex } from "./statusColors";

/** Cap on plotted series, shared with QueryResultsChart: past this the SVG stops being readable. */
export const MAX_SERIES = 50;

/**
 * Turns query rows into chart points + series for MetricChart. Long-form rows (one row per x +
 * group value) are pivoted into one column per group; wide rows carry their y columns through.
 *
 * Mirrors QueryResultsChart's grouped path: rows sharing an x (and group) are aggregated, groups
 * over MAX_SERIES are dropped by lowest absolute total, and the kept groups are ordered by the
 * canonical run-status order first, then alphabetically. Colours match too — the status palette
 * for known statuses, otherwise the series palette by position.
 */
export type SeriesFromRowsConfig = {
  xAxisColumn: string;
  yAxisColumns: string[];
  groupByColumn?: string;
  /** How to combine rows that land on the same x (and group). Defaults to `sum`. */
  aggregation?: AggregationType;
};

export type SeriesFromRowsResult = {
  /** Points keyed by METRIC_X_KEY, ready for MetricChart. */
  points: MetricChartRow[];
  series: MetricSeriesConfig[];
  /** Groups found before the MAX_SERIES cap, so a caller can say what it dropped. */
  totalSeriesCount: number;
};

function toValue(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Known statuses in their canonical order, then everything else alphabetically. */
function compareGroupValues(a: string, b: string): number {
  const rankA = statusOrderIndex(a);
  const rankB = statusOrderIndex(b);
  if (rankA >= 0 && rankB >= 0) return rankA - rankB;
  if (rankA >= 0) return -1;
  if (rankB >= 0) return 1;
  return a.localeCompare(b);
}

export function seriesFromRows(
  rows: MetricChartRow[],
  config: SeriesFromRowsConfig
): SeriesFromRowsResult {
  const { xAxisColumn, yAxisColumns, groupByColumn, aggregation = "sum" } = config;

  const keys: string[] = [];
  const totals = new Map<string, number>();
  // x value (in first-seen order) → series key → samples, or null for a key present with no value
  const buckets = new Map<unknown, Map<string, number[] | null>>();

  const sampleAt = (row: MetricChartRow, key: string, value: unknown) => {
    // The bucket exists even when every y is null, so the x keeps its (empty) point instead of
    // being skipped — a dropped x makes the line bridge the gap.
    const x = row[xAxisColumn];
    let bucket = buckets.get(x);
    if (!bucket) {
      bucket = new Map();
      buckets.set(x, bucket);
    }
    const n = toValue(value);
    if (n === undefined) {
      // A row that names this key with a null y is a gap, not a missing group.
      if (!bucket.has(key)) bucket.set(key, null);
      return;
    }
    if (!keys.includes(key)) keys.push(key);
    totals.set(key, (totals.get(key) ?? 0) + Math.abs(n));
    const samples = bucket.get(key);
    if (samples) samples.push(n);
    else bucket.set(key, [n]);
  };

  for (const row of rows) {
    if (groupByColumn) {
      const yColumn = yAxisColumns[0];
      if (!yColumn) break;
      sampleAt(row, String(row[groupByColumn] ?? ""), row[yColumn]);
    } else {
      for (const yColumn of yAxisColumns) sampleAt(row, yColumn, row[yColumn]);
    }
  }

  let seriesKeys = keys;
  if (groupByColumn) {
    if (seriesKeys.length > MAX_SERIES) {
      seriesKeys = [...seriesKeys]
        .sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0))
        .slice(0, MAX_SERIES);
    }
    seriesKeys = [...seriesKeys].sort(compareGroupValues);
  }

  const points: MetricChartRow[] = [];
  for (const [x, bucket] of buckets) {
    const point: MetricChartRow = {};
    for (const key of seriesKeys) {
      const samples = bucket.get(key);
      // A group absent from a bucket is a zero, so stacked bars keep their baseline; a group
      // present with a null y, and any missing y column value, is a gap.
      point[key] = samples
        ? aggregateValues(samples, aggregation)
        : groupByColumn && !bucket.has(key)
          ? 0
          : null;
    }
    // Set last: a group value equal to the x column name must not displace the coordinate.
    point[METRIC_X_KEY] = x;
    points.push(point);
  }

  const series = seriesKeys.map((key, index) => {
    // Colour y columns by their configured position, so an empty column doesn't shift the rest.
    const configIndex = groupByColumn ? index : yAxisColumns.indexOf(key);
    return {
      key,
      label: key,
      color:
        (groupByColumn ? knownStatusColor(key) : undefined) ??
        getSeriesColor(configIndex >= 0 ? configIndex : index),
    };
  });

  return { points, series, totalSeriesCount: keys.length };
}
