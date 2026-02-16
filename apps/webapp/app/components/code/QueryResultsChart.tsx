import type { ColumnFormatType, OutputColumnMetadata } from "@internal/clickhouse";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { BarChart3, LineChart } from "lucide-react";
import { memo, useMemo } from "react";
import { createValueFormatter } from "~/utils/columnFormat";
import { formatCurrencyAccurate } from "~/utils/numberFormatter";
import type { ChartConfig } from "~/components/primitives/charts/Chart";
import { Chart } from "~/components/primitives/charts/ChartCompound";
import { ChartBlankState } from "../primitives/charts/ChartBlankState";
import type { AggregationType, ChartConfiguration } from "../metrics/QueryWidget";
import { aggregateValues } from "../primitives/charts/aggregation";
import { getRunStatusHexColor } from "~/components/runs/v3/TaskRunStatus";
import { getSeriesColor } from "./chartColors";

interface QueryResultsChartProps {
  rows: Record<string, unknown>[];
  columns: OutputColumnMetadata[];
  config: ChartConfiguration;
  /** The effective time range from the query filter (used to show the full x-axis period) */
  timeRange?: { from: string; to: string };
  fullLegend?: boolean;
  /** Callback when "View all" legend button is clicked */
  onViewAllLegendItems?: () => void;
  /** When true, constrains legend to max 50% height with scrolling */
  legendScrollable?: boolean;
  isLoading?: boolean;
}

interface TransformedData {
  data: Record<string, unknown>[];
  series: string[];
  /** Raw date values for determining formatting granularity */
  dateValues: Date[];
  /** Whether the x-axis is date-based (continuous time scale) */
  isDateBased: boolean;
  /** The data key to use for x-axis (column name or '__timestamp' for dates) */
  xDataKey: string;
  /** Min/max timestamps for domain when date-based */
  timeDomain: [number, number] | null;
  /** Pre-calculated tick values for the time axis */
  timeTicks: number[] | null;
}

/**
 * Time granularity levels for date formatting
 */
type TimeGranularity = "seconds" | "minutes" | "hours" | "days" | "weeks" | "months" | "years";

/**
 * Determines the appropriate time granularity based on the date range
 */
function detectTimeGranularity(dates: Date[]): TimeGranularity {
  if (dates.length < 2) return "days";

  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const minDate = sorted[0];
  const maxDate = sorted[sorted.length - 1];
  const rangeMs = maxDate.getTime() - minDate.getTime();

  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const MONTH = 30 * DAY;
  const YEAR = 365 * DAY;

  // Choose granularity based on range
  if (rangeMs <= 5 * MINUTE) return "seconds"; // < 5 minutes → show seconds
  if (rangeMs <= 2 * HOUR) return "minutes"; // < 2 hours → show minutes
  if (rangeMs <= 2 * DAY) return "hours"; // < 2 days → show hours
  if (rangeMs <= 2 * WEEK) return "days"; // < 2 weeks → show days
  if (rangeMs <= 3 * MONTH) return "weeks"; // < 3 months → show weeks
  if (rangeMs <= 2 * YEAR) return "months"; // < 2 years → show months
  return "years"; // >= 2 years → show years
}

/**
 * Formats a date for the X-axis based on the detected granularity
 */
function formatDateByGranularity(date: Date, granularity: TimeGranularity): string {
  switch (granularity) {
    case "seconds":
      // "10:30:45"
      return date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    case "minutes":
      // "10:30"
      return date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    case "hours":
      // "Jan 15 10:00"
      return `${date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })} ${date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })}`;
    case "days":
      // "Jan 15"
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    case "weeks":
      // "Jan 15"
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    case "months":
      // "Jan 2024"
      return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    case "years":
      // "2024"
      return date.toLocaleDateString("en-US", { year: "numeric" });
    default:
      return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
}

/**
 * Snap a millisecond value up to the nearest "nice" interval
 */
function snapToNiceInterval(ms: number): number {
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  if (ms <= SECOND) return SECOND;
  if (ms <= 5 * SECOND) return 5 * SECOND;
  if (ms <= 10 * SECOND) return 10 * SECOND;
  if (ms <= 15 * SECOND) return 15 * SECOND;
  if (ms <= 30 * SECOND) return 30 * SECOND;
  if (ms <= MINUTE) return MINUTE;
  if (ms <= 5 * MINUTE) return 5 * MINUTE;
  if (ms <= 10 * MINUTE) return 10 * MINUTE;
  if (ms <= 15 * MINUTE) return 15 * MINUTE;
  if (ms <= 30 * MINUTE) return 30 * MINUTE;
  if (ms <= HOUR) return HOUR;
  if (ms <= 2 * HOUR) return 2 * HOUR;
  if (ms <= 4 * HOUR) return 4 * HOUR;
  if (ms <= 6 * HOUR) return 6 * HOUR;
  if (ms <= 12 * HOUR) return 12 * HOUR;
  if (ms <= DAY) return DAY;

  return ms;
}

/**
 * Detect the most common interval between consecutive data points
 * This helps us understand the natural granularity of the data
 */
function detectDataInterval(timestamps: number[]): number {
  if (timestamps.length < 2) return 24 * 60 * 60 * 1000; // Default to 1 day

  const sorted = [...timestamps].sort((a, b) => a - b);
  const gaps: number[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0) {
      gaps.push(gap);
    }
  }

  if (gaps.length === 0) return 60 * 1000;

  // Find the most common small gap (this is likely the data's natural interval)
  // We use the minimum gap as a heuristic for the data interval
  const minGap = Math.min(...gaps);

  return snapToNiceInterval(minGap);
}

/**
 * Fill in missing time slots with zero values
 * This ensures the chart shows gaps as zeros rather than connecting distant points
 */
function fillTimeGaps(
  data: Record<string, unknown>[],
  xDataKey: string,
  series: string[],
  minTime: number,
  maxTime: number,
  interval: number,
  granularity: TimeGranularity,
  aggregation: AggregationType,
  maxPoints = 1000
): Record<string, unknown>[] {
  const range = maxTime - minTime;
  const estimatedPoints = Math.ceil(range / interval);

  // If filling would create too many points, increase the interval to stay within limits
  let effectiveInterval = interval;
  if (estimatedPoints > maxPoints) {
    effectiveInterval = snapToNiceInterval(Math.ceil(range / maxPoints));
  }

  // Create a map to collect values for each bucket (for aggregation)
  const bucketData = new Map<
    number,
    { values: Record<string, number[]>; rawDate: Date; originalX: string }
  >();

  for (const point of data) {
    const timestamp = point[xDataKey] as number;
    // Bucket to the nearest interval
    const bucketedTime = Math.floor(timestamp / effectiveInterval) * effectiveInterval;

    if (!bucketData.has(bucketedTime)) {
      bucketData.set(bucketedTime, {
        values: Object.fromEntries(series.map((s) => [s, []])),
        rawDate: new Date(bucketedTime),
        originalX: new Date(bucketedTime).toISOString(),
      });
    }

    const bucket = bucketData.get(bucketedTime)!;
    for (const s of series) {
      const val = point[s] as number;
      if (typeof val === "number") {
        bucket.values[s].push(val);
      }
    }
  }

  // Generate all time slots and fill with zeros where missing
  const filledData: Record<string, unknown>[] = [];
  const startTime = Math.floor(minTime / effectiveInterval) * effectiveInterval;

  for (let t = startTime; t <= maxTime; t += effectiveInterval) {
    const bucket = bucketData.get(t);
    if (bucket) {
      // Apply aggregation to collected values
      const point: Record<string, unknown> = {
        [xDataKey]: t,
        __rawDate: bucket.rawDate,
        __granularity: granularity,
        __originalX: bucket.originalX,
      };
      for (const s of series) {
        point[s] = aggregateValues(bucket.values[s], aggregation);
      }
      filledData.push(point);
    } else {
      // Create a null-filled data point so gaps appear in line/bar charts
      // and legend aggregations (avg/min/max) skip these slots
      const gapPoint: Record<string, unknown> = {
        [xDataKey]: t,
        __rawDate: new Date(t),
        __granularity: granularity,
        __originalX: new Date(t).toISOString(),
      };
      for (const s of series) {
        gapPoint[s] = null;
      }
      filledData.push(gapPoint);
    }
  }

  return filledData;
}

/**
 * "Nice" intervals for time axes - these create human-friendly tick marks
 */
const NICE_TIME_INTERVALS = [
  { value: 1000, label: "1s" }, // 1 second
  { value: 5 * 1000, label: "5s" }, // 5 seconds
  { value: 10 * 1000, label: "10s" }, // 10 seconds
  { value: 30 * 1000, label: "30s" }, // 30 seconds
  { value: 60 * 1000, label: "1m" }, // 1 minute
  { value: 5 * 60 * 1000, label: "5m" }, // 5 minutes
  { value: 10 * 60 * 1000, label: "10m" }, // 10 minutes
  { value: 15 * 60 * 1000, label: "15m" }, // 15 minutes
  { value: 30 * 60 * 1000, label: "30m" }, // 30 minutes
  { value: 60 * 60 * 1000, label: "1h" }, // 1 hour
  { value: 2 * 60 * 60 * 1000, label: "2h" }, // 2 hours
  { value: 3 * 60 * 60 * 1000, label: "3h" }, // 3 hours
  { value: 4 * 60 * 60 * 1000, label: "4h" }, // 4 hours
  { value: 6 * 60 * 60 * 1000, label: "6h" }, // 6 hours
  { value: 12 * 60 * 60 * 1000, label: "12h" }, // 12 hours
  { value: 24 * 60 * 60 * 1000, label: "1d" }, // 1 day
  { value: 2 * 24 * 60 * 60 * 1000, label: "2d" }, // 2 days
  { value: 7 * 24 * 60 * 60 * 1000, label: "1w" }, // 1 week
  { value: 14 * 24 * 60 * 60 * 1000, label: "2w" }, // 2 weeks
  { value: 30 * 24 * 60 * 60 * 1000, label: "1mo" }, // ~1 month
  { value: 90 * 24 * 60 * 60 * 1000, label: "3mo" }, // ~3 months
  { value: 180 * 24 * 60 * 60 * 1000, label: "6mo" }, // ~6 months
  { value: 365 * 24 * 60 * 60 * 1000, label: "1y" }, // 1 year
];

/**
 * Generate evenly-spaced tick values for a time axis using "nice" intervals
 * that align to natural time boundaries (midnight, noon, hour marks, etc.)
 */
function generateTimeTicks(minTime: number, maxTime: number, maxTicks = 8): number[] {
  const range = maxTime - minTime;

  if (range <= 0) {
    return [minTime];
  }

  // Find the best "nice" interval that gives us a reasonable number of ticks
  // Target: between 4 and maxTicks ticks
  let chosenInterval = NICE_TIME_INTERVALS[NICE_TIME_INTERVALS.length - 1].value;

  for (const { value: interval } of NICE_TIME_INTERVALS) {
    const tickCount = Math.ceil(range / interval);
    if (tickCount <= maxTicks && tickCount >= 2) {
      chosenInterval = interval;
      break;
    }
  }

  // Align the start tick to a nice boundary
  // For intervals >= 1 day, align to midnight
  // For intervals >= 1 hour, align to hour boundary
  // For intervals >= 1 minute, align to minute boundary
  const DAY = 24 * 60 * 60 * 1000;
  const HOUR = 60 * 60 * 1000;
  const MINUTE = 60 * 1000;

  let alignTo: number;
  if (chosenInterval >= DAY) {
    // Align to midnight UTC (or we could use local midnight)
    alignTo = DAY;
  } else if (chosenInterval >= HOUR) {
    alignTo = chosenInterval; // Align to the interval itself for hours
  } else if (chosenInterval >= MINUTE) {
    alignTo = chosenInterval;
  } else {
    alignTo = chosenInterval;
  }

  // Round down to the alignment boundary, then find first tick at or before minTime
  const startTick = Math.floor(minTime / alignTo) * alignTo;

  // Generate ticks
  const ticks: number[] = [];
  for (let t = startTick; t <= maxTime + chosenInterval; t += chosenInterval) {
    if (t >= minTime - chosenInterval * 0.1 && t <= maxTime + chosenInterval * 0.1) {
      ticks.push(t);
    }
  }

  // Ensure we have at least 2 ticks
  if (ticks.length < 2) {
    return [minTime, maxTime];
  }

  return ticks;
}

/**
 * Formats a date for tooltips and legend headers.
 * Always includes time when the data point has a non-midnight time,
 * so hovering a specific bar at e.g. 14:00 shows the full timestamp
 * even when the axis labels only show the day.
 * Seconds are shown whenever the granularity is "seconds" or the
 * specific data point has non-zero seconds.
 */
function formatDateForTooltip(date: Date, granularity: TimeGranularity): string {
  const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0 || date.getSeconds() !== 0;
  const hasSeconds = date.getSeconds() !== 0;

  if (
    granularity === "seconds" ||
    (hasTime && granularity !== "months" && granularity !== "years")
  ) {
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: granularity === "seconds" || hasSeconds ? "2-digit" : undefined,
      hour12: false,
    });
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Try to parse a value as a Date
 */
function tryParseDate(value: unknown): Date | null {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "number") {
    // First, try treating the number as milliseconds
    const dateAsMs = new Date(value);
    if (
      !isNaN(dateAsMs.getTime()) &&
      dateAsMs.getFullYear() >= 1970 &&
      dateAsMs.getFullYear() <= 2100
    ) {
      return dateAsMs;
    }
    // If that fails, try treating the number as seconds (Unix timestamp)
    const dateAsSec = new Date(value * 1000);
    if (
      !isNaN(dateAsSec.getTime()) &&
      dateAsSec.getFullYear() >= 1970 &&
      dateAsSec.getFullYear() <= 2100
    ) {
      return dateAsSec;
    }
  }
  return null;
}

/**
 * Transform raw query results into chart-ready data
 *
 * When grouped:
 * - Pivots data so each unique group value becomes a separate series
 * - Each row in output has xAxis value + one key per group value
 *
 * When not grouped:
 * - Uses Y-axis columns directly as series
 *
 * For date-based x-axes:
 * - Uses numeric timestamps so the chart renders with a continuous time scale
 * - This ensures gaps in data are visually apparent
 */
function transformDataForChart(
  rows: Record<string, unknown>[],
  config: ChartConfiguration,
  timeRange?: { from: string; to: string }
): TransformedData {
  const { xAxisColumn, yAxisColumns, groupByColumn, aggregation } = config;

  if (!xAxisColumn || yAxisColumns.length === 0) {
    return {
      data: [],
      series: [],
      dateValues: [],
      isDateBased: false,
      xDataKey: xAxisColumn || "",
      timeDomain: null,
      timeTicks: null,
    };
  }

  // Collect date values for granularity detection
  const dateValues: Date[] = [];
  for (const row of rows) {
    const date = tryParseDate(row[xAxisColumn]);
    if (date) {
      dateValues.push(date);
    }
  }

  // Determine if X-axis is date-based (most values should be parseable as dates)
  // When there are no results but a timeRange is provided, treat as date-based
  const isDateBased =
    rows.length === 0 && timeRange ? true : dateValues.length >= rows.length * 0.8; // At least 80% are dates

  // Detect granularity from the full time range when available, otherwise from data
  const granularity = isDateBased
    ? timeRange
      ? detectTimeGranularity([new Date(timeRange.from), new Date(timeRange.to)])
      : detectTimeGranularity(dateValues)
    : "days";

  // For date-based axes, use a special key for the timestamp
  const xDataKey = isDateBased ? "__timestamp" : xAxisColumn;

  // Calculate time domain and ticks for date-based axes
  // When a timeRange is provided (from the query filter), use it so the chart
  // shows the full requested period rather than just the range of returned data.
  let timeDomain: [number, number] | null = null;
  let timeTicks: number[] | null = null;
  // Raw min/max used for gap filling (without padding)
  let rawMinTime = 0;
  let rawMaxTime = 0;
  if (isDateBased && (dateValues.length > 0 || timeRange)) {
    const dataTimestamps = dateValues.map((d) => d.getTime());
    rawMinTime = timeRange ? new Date(timeRange.from).getTime() : Math.min(...dataTimestamps);
    rawMaxTime = timeRange ? new Date(timeRange.to).getTime() : Math.max(...dataTimestamps);
    // Add a small padding (2% on each side) so points aren't at the very edge
    const padding = (rawMaxTime - rawMinTime) * 0.02;
    timeDomain = [rawMinTime - padding, rawMaxTime + padding];
    // Generate evenly-spaced ticks across the entire range using nice intervals
    timeTicks = generateTimeTicks(rawMinTime, rawMaxTime);
  }

  // Helper to format X value for categorical axes (non-date)
  const formatX = (value: unknown): string => {
    if (value === null || value === undefined) return "N/A";
    return String(value);
  };

  // No grouping: use Y columns directly as series
  // Group rows by X value first, then aggregate
  if (!groupByColumn) {
    // Group rows by X-axis value to handle duplicates
    const groupedByX = new Map<
      string | number,
      { yValues: Record<string, number[]>; rawDate: Date | null; originalX: unknown }
    >();

    for (const row of rows) {
      const rawDate = tryParseDate(row[xAxisColumn]);

      // Skip rows with invalid dates for date-based axes
      if (isDateBased && !rawDate) continue;

      const xKey = isDateBased && rawDate ? rawDate.getTime() : formatX(row[xAxisColumn]);

      if (!groupedByX.has(xKey)) {
        groupedByX.set(xKey, {
          yValues: Object.fromEntries(yAxisColumns.map((col) => [col, []])),
          rawDate,
          originalX: row[xAxisColumn],
        });
      }

      const existing = groupedByX.get(xKey)!;
      for (const yCol of yAxisColumns) {
        existing.yValues[yCol].push(toNumber(row[yCol]));
      }
    }

    // Convert to array format with aggregation applied
    let data = Array.from(groupedByX.entries()).map(([xKey, { yValues, rawDate, originalX }]) => {
      const point: Record<string, unknown> = {
        [xDataKey]: xKey,
        __rawDate: rawDate,
        __granularity: granularity,
        __originalX: originalX,
      };
      for (const yCol of yAxisColumns) {
        point[yCol] = aggregateValues(yValues[yCol], aggregation);
      }
      return point;
    });

    // Fill in gaps with zeros for date-based data
    if (isDateBased && timeDomain) {
      const timestamps = dateValues.map((d) => d.getTime());
      const dataInterval = detectDataInterval(timestamps);
      // When filling across a full time range, ensure the interval is appropriate
      // for the range size (target ~150 points) so we don't create overly dense charts
      const rangeMs = rawMaxTime - rawMinTime;
      const minRangeInterval = timeRange ? snapToNiceInterval(rangeMs / 150) : 0;
      // Also cap the interval so we get enough data points to visually represent
      // the full time range. Without this, limited data (e.g. 1 point) defaults
      // to a 1-day interval which can be far too coarse for shorter ranges,
      // producing too few bars/points and potentially buckets outside the domain.
      const maxRangeInterval =
        timeRange && rangeMs > 0 ? snapToNiceInterval(rangeMs / 8) : Infinity;
      const effectiveInterval = Math.min(
        Math.max(dataInterval, minRangeInterval),
        maxRangeInterval
      );
      data = fillTimeGaps(
        data,
        xDataKey,
        yAxisColumns,
        rawMinTime,
        rawMaxTime,
        effectiveInterval,
        granularity,
        aggregation
      );
    }

    return { data, series: yAxisColumns, dateValues, isDateBased, xDataKey, timeDomain, timeTicks };
  }

  // With grouping: pivot data so each group value becomes a series
  const yCol = yAxisColumns[0]; // Use first Y column when grouping
  const groupValues = new Set<string>();

  // For date-based, key by timestamp; otherwise by formatted string
  // Collect all values for aggregation
  const groupedByX = new Map<
    string | number,
    { values: Record<string, number[]>; rawDate: Date | null; originalX: unknown }
  >();

  for (const row of rows) {
    const rawDate = tryParseDate(row[xAxisColumn]);

    // Skip rows with invalid dates for date-based axes
    if (isDateBased && !rawDate) continue;

    const xKey = isDateBased && rawDate ? rawDate.getTime() : formatX(row[xAxisColumn]);
    const groupValue = String(row[groupByColumn] ?? "Unknown");
    const yValue = toNumber(row[yCol]);

    groupValues.add(groupValue);

    if (!groupedByX.has(xKey)) {
      groupedByX.set(xKey, { values: {}, rawDate, originalX: row[xAxisColumn] });
    }

    const existing = groupedByX.get(xKey)!;
    // Collect values for aggregation
    if (!existing.values[groupValue]) {
      existing.values[groupValue] = [];
    }
    existing.values[groupValue].push(yValue);
  }

  // Convert to array format with aggregation applied
  const series = Array.from(groupValues).sort();
  let data = Array.from(groupedByX.entries()).map(([xKey, { values, rawDate, originalX }]) => {
    const point: Record<string, unknown> = {
      [xDataKey]: xKey,
      __rawDate: rawDate,
      __granularity: granularity,
      __originalX: originalX,
    };
    for (const group of series) {
      point[group] = values[group] ? aggregateValues(values[group], aggregation) : 0;
    }
    return point;
  });

  // Fill in gaps with zeros for date-based data
  if (isDateBased && timeDomain) {
    const timestamps = dateValues.map((d) => d.getTime());
    const dataInterval = detectDataInterval(timestamps);
    // When filling across a full time range, ensure the interval is appropriate
    // for the range size (target ~150 points) so we don't create overly dense charts
    const rangeMs = rawMaxTime - rawMinTime;
    const minRangeInterval = timeRange ? snapToNiceInterval(rangeMs / 150) : 0;
    // Also cap the interval so we get enough data points to visually represent
    // the full time range. Without this, limited data (e.g. 1 point) defaults
    // to a 1-day interval which can be far too coarse for shorter ranges,
    // producing too few bars/points and potentially buckets outside the domain.
    const maxRangeInterval =
      timeRange && rangeMs > 0 ? snapToNiceInterval(rangeMs / 8) : Infinity;
    const effectiveInterval = Math.min(
      Math.max(dataInterval, minRangeInterval),
      maxRangeInterval
    );
    data = fillTimeGaps(
      data,
      xDataKey,
      series,
      rawMinTime,
      rawMaxTime,
      effectiveInterval,
      granularity,
      aggregation
    );
  }

  return { data, series, dateValues, isDateBased, xDataKey, timeDomain, timeTicks };
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

/**
 * Sort data array by a specified column
 */
function sortData(
  data: Record<string, unknown>[],
  sortByColumn: string | null,
  sortDirection: "asc" | "desc",
  xAxisColumn?: string | null
): Record<string, unknown>[] {
  if (!sortByColumn) return data;

  return [...data].sort((a, b) => {
    const aVal = a[sortByColumn];
    const bVal = b[sortByColumn];

    // Handle null/undefined
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return sortDirection === "asc" ? -1 : 1;
    if (bVal == null) return sortDirection === "asc" ? 1 : -1;

    // Only use date comparison when sorting by the X-axis column
    if (sortByColumn === xAxisColumn) {
      const aDate = a.__rawDate as Date | null;
      const bDate = b.__rawDate as Date | null;
      if (aDate && bDate) {
        const diff = aDate.getTime() - bDate.getTime();
        return sortDirection === "asc" ? diff : -diff;
      }
    }

    // Compare as numbers if possible
    const aNum = typeof aVal === "number" ? aVal : parseFloat(String(aVal));
    const bNum = typeof bVal === "number" ? bVal : parseFloat(String(bVal));
    if (!isNaN(aNum) && !isNaN(bNum)) {
      return sortDirection === "asc" ? aNum - bNum : bNum - aNum;
    }

    // Fall back to string comparison
    const aStr = String(aVal);
    const bStr = String(bVal);
    const cmp = aStr.localeCompare(bStr);
    return sortDirection === "asc" ? cmp : -cmp;
  });
}

export const QueryResultsChart = memo(function QueryResultsChart({
  rows,
  columns,
  config,
  timeRange,
  fullLegend = false,
  onViewAllLegendItems,
  isLoading = false,
  legendScrollable = false,
}: QueryResultsChartProps) {
  const {
    xAxisColumn,
    yAxisColumns,
    chartType,
    groupByColumn,
    stacked,
    sortByColumn,
    sortDirection,
  } = config;

  // Transform data for charting
  const {
    data: unsortedData,
    series,
    dateValues,
    isDateBased,
    xDataKey,
    timeDomain,
    timeTicks,
  } = useMemo(() => transformDataForChart(rows, config, timeRange), [rows, config, timeRange]);

  // Apply sorting (for date-based, sort by timestamp to ensure correct order)
  const data = useMemo(() => {
    if (isDateBased) {
      // Always sort by timestamp for date-based axes
      return sortData(unsortedData, xDataKey, "asc", xDataKey);
    }
    return sortData(unsortedData, sortByColumn, sortDirection, xDataKey);
  }, [unsortedData, sortByColumn, sortDirection, isDateBased, xDataKey]);

  // Sort series by descending total sum so largest appears at bottom of
  // stacked charts and first in the legend
  const sortedSeries = useMemo(() => {
    if (series.length <= 1) return series;
    const totals = new Map<string, number>();
    for (const s of series) {
      let total = 0;
      for (const point of data) {
        const val = point[s];
        if (typeof val === "number" && isFinite(val)) {
          total += Math.abs(val);
        }
      }
      totals.set(s, total);
    }
    return [...series].sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0));
  }, [series, data]);

  // Detect time granularity — use the full time range when available so tick
  // labels are appropriate for the period (e.g. "Jan 5" for a 7-day range
  // instead of just "16:00:00" when data is sparse)
  const timeGranularity = useMemo(() => {
    if (timeRange) {
      return detectTimeGranularity([new Date(timeRange.from), new Date(timeRange.to)]);
    }
    return dateValues.length > 0 ? detectTimeGranularity(dateValues) : null;
  }, [dateValues, timeRange]);

  // X-axis tick formatter for date-based axes (pure – no deduplication).
  // Label deduplication is handled inside dateAxisTick below so that the
  // mutable "lastLabel" state is correctly reset on each Recharts render pass.
  const xAxisTickFormatter = useMemo(() => {
    if (!isDateBased || !timeGranularity) return undefined;
    return (value: number) => {
      const date = new Date(value);
      return formatDateByGranularity(date, timeGranularity);
    };
  }, [isDateBased, timeGranularity]);

  // Resolve the Y-axis column format for formatting
  const yAxisFormat = useMemo(() => {
    if (yAxisColumns.length === 0) return undefined;
    const col = columns.find((c) => c.name === yAxisColumns[0]);
    return (col?.format ?? col?.customRenderType) as ColumnFormatType | undefined;
  }, [yAxisColumns, columns]);

  // Create dynamic Y-axis formatter based on data range and format
  const yAxisFormatter = useMemo(
    () => createYAxisFormatter(data, series, yAxisFormat),
    [data, series, yAxisFormat]
  );

  // Create value formatter for tooltips and legend based on column format
  const tooltipValueFormatter = useMemo(
    () => createValueFormatter(yAxisFormat),
    [yAxisFormat]
  );

  // Check if the group-by column has a runStatus customRenderType
  const groupByIsRunStatus = useMemo(() => {
    if (!groupByColumn) return false;
    const col = columns.find((c) => c.name === groupByColumn);
    return col?.customRenderType === "runStatus";
  }, [groupByColumn, columns]);

  // Build chart config for colors/labels
  const chartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    sortedSeries.forEach((s, i) => {
      const statusColor = groupByIsRunStatus ? getRunStatusHexColor(s) : undefined;
      cfg[s] = {
        label: s,
        color: statusColor ?? config.seriesColors?.[s] ?? getSeriesColor(i),
      };
    });
    return cfg;
  }, [sortedSeries, groupByIsRunStatus, config.seriesColors]);

  // Custom tooltip label formatter for better date display
  const tooltipLabelFormatter = useMemo(() => {
    return (label: string, payload: Array<{ payload?: Record<string, unknown> }>) => {
      // Try to get the raw date from the payload for better formatting
      const rawDate = payload[0]?.payload?.__rawDate as Date | null | undefined;
      const granularity = payload[0]?.payload?.__granularity as TimeGranularity | undefined;

      if (rawDate && granularity) {
        return formatDateForTooltip(rawDate, granularity);
      }
      return label;
    };
  }, []);

  // Label formatter for the legend (formats x-axis values)
  const legendLabelFormatter = useMemo(() => {
    if (!isDateBased || !timeGranularity) return undefined;
    return (value: string) => {
      // For date-based axes, the value is a timestamp
      const timestamp = Number(value);
      if (!isNaN(timestamp)) {
        const date = new Date(timestamp);
        return formatDateForTooltip(date, timeGranularity);
      }
      return value;
    };
  }, [isDateBased, timeGranularity]);

  // Y-axis domain calculation - must be before early returns to maintain consistent hook order
  const yAxisDomain = useMemo(() => {
    let min = 0;
    for (const point of data) {
      for (const s of series) {
        const val = point[s];
        if (typeof val === "number" && isFinite(val)) {
          min = Math.min(min, val);
        }
      }
    }
    return [min, "auto"] as [number, string];
  }, [data, series]);

  // Angle all date-based labels for consistent appearance and to avoid overlap
  const xAxisAngle = isDateBased ? -45 : 0;
  const xAxisHeight = xAxisAngle !== 0 ? 65 : undefined;

  // Check if the data would produce duplicate labels at the current granularity.
  // Only use the custom tick renderer (with interval:0) when duplicates exist,
  // otherwise let Recharts handle label spacing to avoid collisions.
  const hasDuplicateLabels = useMemo(() => {
    if (!isDateBased || !timeGranularity || data.length === 0) return false;
    const labels = new Set<string>();
    for (const point of data) {
      const ts = point.__timestamp ?? point[xDataKey];
      if (typeof ts === "number") {
        labels.add(formatDateByGranularity(new Date(ts), timeGranularity));
      }
    }
    return labels.size < data.length;
  }, [isDateBased, timeGranularity, data, xDataKey]);

  // Custom tick renderer for date-based axes: renders a tick mark alongside
  // each label, and for unlabelled points (de-duplicated) just a subtle tick mark.
  // De-duplication lives here (not in xAxisTickFormatter) so that the mutable
  // lastLabel is reset when Recharts starts a new render pass (index === 0).
  const dateAxisTick = useMemo(() => {
    if (!isDateBased || !xAxisTickFormatter) return undefined;
    let lastLabel = "";
    return (props: Record<string, unknown>) => {
      const { x, y, payload, index } = props as {
        x: number;
        y: number;
        payload: { value: number };
        index: number;
      };

      // Reset dedup state at the start of each Recharts render pass
      if (index === 0) lastLabel = "";

      const formatted = xAxisTickFormatter(payload.value);
      const label = formatted === lastLabel ? "" : formatted;
      lastLabel = formatted;
      // y is the tick text position, offset from the axis by tickMargin + internal padding
      const axisY = (y as number) - 12;
      if (label) {
        return (
          <g>
            <line
              x1={x as number}
              y1={axisY}
              x2={x as number}
              y2={axisY - 3}
              stroke="#878C99"
              strokeWidth={1}
            />
            <text
              x={x}
              y={axisY}
              dy={10}
              fill="#878C99"
              fontSize={11}
              textAnchor={xAxisAngle !== 0 ? "end" : "middle"}
              style={{ fontVariantNumeric: "tabular-nums" }}
              transform={
                xAxisAngle !== 0 ? `rotate(${xAxisAngle}, ${x}, ${axisY + 10})` : undefined
              }
            >
              {label}
            </text>
          </g>
        );
      }
      // Small tick mark sitting on the axis baseline, pointing upward
      return (
        <line
          x1={x as number}
          y1={axisY}
          x2={x as number}
          y2={axisY - 3}
          stroke="#272A2E"
          strokeWidth={1}
        />
      );
    };
  }, [isDateBased, xAxisTickFormatter, xAxisAngle]);

  // Validation — all hooks must be above this point
  const chartIcon = chartType === "bar" ? BarChart3 : LineChart;

  if (!xAxisColumn) {
    return <ChartBlankState icon={chartIcon} message="Select an X-axis column to display the chart" />;
  }

  if (yAxisColumns.length === 0) {
    return <ChartBlankState icon={chartIcon} message="Select a Y-axis column to display the chart" />;
  }

  if (rows.length === 0) {
    return <ChartBlankState icon={chartIcon} message="No data to display" />;
  }

  if (data.length === 0) {
    return <ChartBlankState icon={chartIcon} message="Unable to transform data for chart" />;
  }

  // Base x-axis props shared by all chart types
  const baseXAxisProps = {
    ...(dateAxisTick
      ? {
          tick: dateAxisTick,
          tickLine: false,
          tickFormatter: undefined,
          // Only force every tick to render when there are duplicates to de-duplicate;
          // otherwise let Recharts auto-space to avoid label collisions
          ...(hasDuplicateLabels ? { interval: 0 } : {}),
        }
      : { tickFormatter: xAxisTickFormatter }),
    angle: xAxisAngle,
    textAnchor: xAxisAngle !== 0 ? ("end" as const) : ("middle" as const),
    height: xAxisHeight,
  };

  // Line charts use continuous time scale for date-based data
  // This properly represents time gaps between data points
  const xAxisPropsForLine = isDateBased
    ? {
        type: "number" as const,
        domain: timeDomain ?? (["auto", "auto"] as [string, string]),
        scale: "time" as const,
        // Explicitly specify tick positions so labels appear across the entire range
        ticks: timeTicks ?? undefined,
        ...baseXAxisProps,
      }
    : baseXAxisProps;

  // Bar charts always use categorical axis positioning
  // This ensures bars are evenly distributed regardless of data point count
  // (prevents massive bars when there are only a few data points)
  const xAxisPropsForBar = baseXAxisProps;

  const yAxisProps = {
    tickFormatter: yAxisFormatter,
    domain: yAxisDomain,
  };

  const showLegend = sortedSeries.length > 0;

  if (chartType === "bar") {
    return (
      <Chart.Root
        config={chartConfig}
        data={data}
        dataKey={xDataKey}
        series={sortedSeries}
        labelFormatter={legendLabelFormatter}
        showLegend={showLegend}
        maxLegendItems={fullLegend ? Infinity : 5}
        legendAggregation={config.aggregation}
        legendValueFormatter={tooltipValueFormatter}
        minHeight="300px"
        fillContainer
        onViewAllLegendItems={onViewAllLegendItems}
        legendScrollable={legendScrollable}
        state={isLoading ? "loading" : "loaded"}
      >
        <Chart.Bar
          xAxisProps={xAxisPropsForBar}
          yAxisProps={yAxisProps}
          stackId={stacked ? "stack" : undefined}
          tooltipLabelFormatter={tooltipLabelFormatter}
          tooltipValueFormatter={tooltipValueFormatter}
        />
      </Chart.Root>
    );
  }

  // Line or stacked area chart
  return (
    <Chart.Root
      config={chartConfig}
      data={data}
      dataKey={xDataKey}
      series={sortedSeries}
      labelFormatter={legendLabelFormatter}
      showLegend={showLegend}
      maxLegendItems={fullLegend ? Infinity : 5}
      legendAggregation={config.aggregation}
      legendValueFormatter={tooltipValueFormatter}
      minHeight="300px"
      fillContainer
      onViewAllLegendItems={onViewAllLegendItems}
      legendScrollable={legendScrollable}
      state={isLoading ? "loading" : "loaded"}
    >
      <Chart.Line
        xAxisProps={xAxisPropsForLine}
        yAxisProps={yAxisProps}
        stacked={stacked && sortedSeries.length > 1}
        tooltipLabelFormatter={tooltipLabelFormatter}
        tooltipValueFormatter={tooltipValueFormatter}
        lineType="linear"
      />
    </Chart.Root>
  );
});

/**
 * Creates a Y-axis value formatter based on the data range and optional format hint
 */
function createYAxisFormatter(
  data: Record<string, unknown>[],
  series: string[],
  format?: ColumnFormatType
) {
  // Find min and max values across all series
  let minVal = Infinity;
  let maxVal = -Infinity;

  for (const point of data) {
    for (const s of series) {
      const val = point[s];
      if (typeof val === "number" && isFinite(val)) {
        minVal = Math.min(minVal, val);
        maxVal = Math.max(maxVal, val);
      }
    }
  }

  const range = maxVal - minVal;

  // Format-aware formatters
  if (format === "bytes" || format === "decimalBytes") {
    const divisor = format === "bytes" ? 1024 : 1000;
    const units =
      format === "bytes"
        ? ["B", "KiB", "MiB", "GiB", "TiB"]
        : ["B", "KB", "MB", "GB", "TB"];
    return (value: number): string => {
      if (value === 0) return "0 B";
      // Use consistent unit for all ticks based on max value
      const i = Math.min(
        Math.max(0, Math.floor(Math.log(Math.abs(maxVal || 1)) / Math.log(divisor))),
        units.length - 1
      );
      const scaled = value / Math.pow(divisor, i);
      return `${scaled.toFixed(scaled < 10 ? 1 : 0)} ${units[i]}`;
    };
  }

  if (format === "percent") {
    return (value: number): string => `${value.toFixed(range < 1 ? 2 : 1)}%`;
  }

  if (format === "duration") {
    return (value: number): string => formatDurationMilliseconds(value, { style: "short" });
  }

  if (format === "durationSeconds") {
    return (value: number): string =>
      formatDurationMilliseconds(value * 1000, { style: "short" });
  }

  if (format === "costInDollars" || format === "cost") {
    return (value: number): string => {
      const dollars = format === "cost" ? value / 100 : value;
      return formatCurrencyAccurate(dollars);
    };
  }

  // Default formatter
  return (value: number): string => {
    // Use abbreviations for large numbers
    if (Math.abs(value) >= 1_000_000) {
      return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (Math.abs(value) >= 1_000) {
      return `${(value / 1_000).toFixed(1)}K`;
    }

    // Determine decimal places based on range
    if (range === 0 || !isFinite(range)) {
      return Number.isInteger(value) ? value.toString() : value.toFixed(2);
    }

    // For small ranges, show more precision
    if (range < 0.01) {
      return value.toFixed(4);
    }
    if (range < 0.1) {
      return value.toFixed(3);
    }
    if (range < 10) {
      return value.toFixed(2);
    }
    if (range < 100) {
      return value.toFixed(1);
    }

    // For large ranges, no decimals
    return Math.round(value).toString();
  };
}

