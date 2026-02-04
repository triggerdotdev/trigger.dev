import type { OutputColumnMetadata } from "@internal/clickhouse";
import { memo, useMemo } from "react";
import type { ChartConfig } from "~/components/primitives/charts/Chart";
import { Chart } from "~/components/primitives/charts/ChartCompound";
import { Paragraph } from "../primitives/Paragraph";
import type { AggregationType, ChartConfiguration } from "./ChartConfigPanel";

// Color palette for chart series - 30 distinct colors for large datasets
const CHART_COLORS = [
  // Primary colors
  "#7655fd", // Purple
  "#22c55e", // Green
  "#f59e0b", // Amber
  "#ef4444", // Red
  "#06b6d4", // Cyan
  "#ec4899", // Pink
  "#8b5cf6", // Violet
  "#14b8a6", // Teal
  "#f97316", // Orange
  "#6366f1", // Indigo
  // Extended palette
  "#84cc16", // Lime
  "#0ea5e9", // Sky
  "#f43f5e", // Rose
  "#a855f7", // Fuchsia
  "#eab308", // Yellow
  "#10b981", // Emerald
  "#3b82f6", // Blue
  "#d946ef", // Magenta
  "#78716c", // Stone
  "#facc15", // Gold
  // Additional distinct colors
  "#2dd4bf", // Turquoise
  "#fb923c", // Light orange
  "#a3e635", // Yellow-green
  "#38bdf8", // Light blue
  "#c084fc", // Light purple
  "#4ade80", // Light green
  "#fbbf24", // Light amber
  "#f472b6", // Light pink
  "#67e8f9", // Light cyan
  "#818cf8", // Light indigo
];

function getSeriesColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

interface QueryResultsChartProps {
  rows: Record<string, unknown>[];
  columns: OutputColumnMetadata[];
  config: ChartConfiguration;
  fullLegend?: boolean;
  /** Callback when "View all" legend button is clicked */
  onViewAllLegendItems?: () => void;
  /** When true, constrains legend to max 50% height with scrolling */
  legendScrollable?: boolean;
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
 * Detect the most common interval between consecutive data points
 * This helps us understand the natural granularity of the data
 */
function detectDataInterval(timestamps: number[]): number {
  if (timestamps.length < 2) return 60 * 1000; // Default to 1 minute

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

  // Round to a nice interval
  const MINUTE = 60 * 1000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  // Snap to common intervals
  if (minGap <= MINUTE) return MINUTE;
  if (minGap <= 5 * MINUTE) return 5 * MINUTE;
  if (minGap <= 10 * MINUTE) return 10 * MINUTE;
  if (minGap <= 15 * MINUTE) return 15 * MINUTE;
  if (minGap <= 30 * MINUTE) return 30 * MINUTE;
  if (minGap <= HOUR) return HOUR;
  if (minGap <= 2 * HOUR) return 2 * HOUR;
  if (minGap <= 4 * HOUR) return 4 * HOUR;
  if (minGap <= 6 * HOUR) return 6 * HOUR;
  if (minGap <= 12 * HOUR) return 12 * HOUR;
  if (minGap <= DAY) return DAY;

  return minGap;
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
    effectiveInterval = Math.ceil(range / maxPoints);
    // Round up to a nice interval
    const MINUTE = 60 * 1000;
    const HOUR = 60 * MINUTE;
    if (effectiveInterval < 5 * MINUTE) effectiveInterval = 5 * MINUTE;
    else if (effectiveInterval < 10 * MINUTE) effectiveInterval = 10 * MINUTE;
    else if (effectiveInterval < 15 * MINUTE) effectiveInterval = 15 * MINUTE;
    else if (effectiveInterval < 30 * MINUTE) effectiveInterval = 30 * MINUTE;
    else if (effectiveInterval < HOUR) effectiveInterval = HOUR;
    else if (effectiveInterval < 2 * HOUR) effectiveInterval = 2 * HOUR;
    else if (effectiveInterval < 4 * HOUR) effectiveInterval = 4 * HOUR;
    else if (effectiveInterval < 6 * HOUR) effectiveInterval = 6 * HOUR;
    else if (effectiveInterval < 12 * HOUR) effectiveInterval = 12 * HOUR;
    else effectiveInterval = 24 * HOUR;
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
      // Create a zero-filled data point
      const zeroPoint: Record<string, unknown> = {
        [xDataKey]: t,
        __rawDate: new Date(t),
        __granularity: granularity,
        __originalX: new Date(t).toISOString(),
      };
      for (const s of series) {
        zeroPoint[s] = 0;
      }
      filledData.push(zeroPoint);
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
 * Formats a date for tooltips (always shows full precision)
 */
function formatDateForTooltip(date: Date, granularity: TimeGranularity): string {
  // For shorter time ranges, include time
  if (granularity === "seconds" || granularity === "minutes" || granularity === "hours") {
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: granularity === "seconds" ? "2-digit" : undefined,
      hour12: false,
    });
  }
  // For longer ranges, just show date
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
  config: ChartConfiguration
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
  const isDateBased = dateValues.length >= rows.length * 0.8; // At least 80% are dates
  const granularity = isDateBased ? detectTimeGranularity(dateValues) : "days";

  // For date-based axes, use a special key for the timestamp
  const xDataKey = isDateBased ? "__timestamp" : xAxisColumn;

  // Calculate time domain and ticks for date-based axes
  let timeDomain: [number, number] | null = null;
  let timeTicks: number[] | null = null;
  if (isDateBased && dateValues.length > 0) {
    const timestamps = dateValues.map((d) => d.getTime());
    const minTime = Math.min(...timestamps);
    const maxTime = Math.max(...timestamps);
    // Add a small padding (2% on each side) so points aren't at the very edge
    const padding = (maxTime - minTime) * 0.02;
    timeDomain = [minTime - padding, maxTime + padding];
    // Generate evenly-spaced ticks across the entire range using nice intervals
    timeTicks = generateTimeTicks(minTime, maxTime);
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
      data = fillTimeGaps(
        data,
        xDataKey,
        yAxisColumns,
        timeDomain[0],
        timeDomain[1],
        dataInterval,
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
    data = fillTimeGaps(
      data,
      xDataKey,
      series,
      timeDomain[0],
      timeDomain[1],
      dataInterval,
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
 * Aggregate an array of numbers using the specified aggregation function
 */
function aggregateValues(values: number[], aggregation: AggregationType): number {
  if (values.length === 0) return 0;
  switch (aggregation) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "count":
      return values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
  }
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
  fullLegend = false,
  onViewAllLegendItems,
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
  } = useMemo(() => transformDataForChart(rows, config), [rows, config]);

  // Apply sorting (for date-based, sort by timestamp to ensure correct order)
  const data = useMemo(() => {
    if (isDateBased) {
      // Always sort by timestamp for date-based axes
      return sortData(unsortedData, xDataKey, "asc", xDataKey);
    }
    return sortData(unsortedData, sortByColumn, sortDirection, xDataKey);
  }, [unsortedData, sortByColumn, sortDirection, isDateBased, xDataKey]);

  // Detect time granularity for the data
  const timeGranularity = useMemo(
    () => (dateValues.length > 0 ? detectTimeGranularity(dateValues) : null),
    [dateValues]
  );

  // X-axis tick formatter for date-based axes
  const xAxisTickFormatter = useMemo(() => {
    if (!isDateBased || !timeGranularity) return undefined;
    return (value: number) => {
      const date = new Date(value);
      return formatDateByGranularity(date, timeGranularity);
    };
  }, [isDateBased, timeGranularity]);

  // Create dynamic Y-axis formatter based on data range
  const yAxisFormatter = useMemo(() => createYAxisFormatter(data, series), [data, series]);

  // Build chart config for colors/labels
  const chartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    series.forEach((s, i) => {
      cfg[s] = {
        label: s,
        color: getSeriesColor(i),
      };
    });
    return cfg;
  }, [series]);

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

  // Validation
  if (!xAxisColumn) {
    return <EmptyState message="Select an X-axis column to display the chart" />;
  }

  if (yAxisColumns.length === 0) {
    return <EmptyState message="Select a Y-axis column to display the chart" />;
  }

  if (rows.length === 0) {
    return <EmptyState message="No data to display" />;
  }

  if (data.length === 0) {
    return <EmptyState message="Unable to transform data for chart" />;
  }

  // Determine appropriate angle for X-axis labels based on granularity
  const xAxisAngle = timeGranularity === "hours" || timeGranularity === "seconds" ? -45 : 0;
  const xAxisHeight = xAxisAngle !== 0 ? 60 : undefined;

  // Base x-axis props shared by all chart types
  const baseXAxisProps = {
    tickFormatter: xAxisTickFormatter,
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

  const showLegend = series.length > 0;

  if (chartType === "bar") {
    return (
      <Chart.Root
        config={chartConfig}
        data={data}
        dataKey={xDataKey}
        series={series}
        labelFormatter={legendLabelFormatter}
        showLegend={showLegend}
        maxLegendItems={fullLegend ? Infinity : 5}
        minHeight="300px"
        fillContainer
        onViewAllLegendItems={onViewAllLegendItems}
        legendScrollable={legendScrollable}
      >
        <Chart.Bar
          xAxisProps={xAxisPropsForBar}
          yAxisProps={yAxisProps}
          stackId={stacked ? "stack" : undefined}
          tooltipLabelFormatter={tooltipLabelFormatter}
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
      series={series}
      labelFormatter={legendLabelFormatter}
      showLegend={showLegend}
      maxLegendItems={fullLegend ? Infinity : 5}
      minHeight="300px"
      fillContainer
      onViewAllLegendItems={onViewAllLegendItems}
      legendScrollable={legendScrollable}
    >
      <Chart.Line
        xAxisProps={xAxisPropsForLine}
        yAxisProps={yAxisProps}
        stacked={stacked && series.length > 1}
        tooltipLabelFormatter={tooltipLabelFormatter}
        lineType="linear"
      />
    </Chart.Root>
  );
});

/**
 * Creates a Y-axis value formatter based on the data range
 */
function createYAxisFormatter(data: Record<string, unknown>[], series: string[]) {
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

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-full min-h-[300px] items-center justify-center">
      <Paragraph variant="small" className="text-text-dimmed">
        {message}
      </Paragraph>
    </div>
  );
}
