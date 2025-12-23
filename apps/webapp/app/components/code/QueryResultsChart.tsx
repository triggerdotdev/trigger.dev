import type { OutputColumnMetadata } from "@internal/clickhouse";
import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "~/components/primitives/Chart";
import { Paragraph } from "../primitives/Paragraph";
import type { ChartConfiguration } from "./ChartConfigPanel";

// Color palette for chart series
const CHART_COLORS = [
  "#7655fd", // Primary purple
  "#22c55e", // Green
  "#f59e0b", // Amber
  "#ef4444", // Red
  "#06b6d4", // Cyan
  "#ec4899", // Pink
  "#8b5cf6", // Violet
  "#14b8a6", // Teal
  "#f97316", // Orange
  "#6366f1", // Indigo
];

function getSeriesColor(index: number): string {
  return CHART_COLORS[index % CHART_COLORS.length];
}

interface QueryResultsChartProps {
  rows: Record<string, unknown>[];
  columns: OutputColumnMetadata[];
  config: ChartConfiguration;
}

interface TransformedData {
  data: Record<string, unknown>[];
  series: string[];
  /** Raw date values for determining formatting granularity */
  dateValues: Date[];
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
    // Could be a timestamp
    const date = new Date(value);
    // Sanity check: should be between 1970 and 2100
    if (date.getFullYear() >= 1970 && date.getFullYear() <= 2100) {
      return date;
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
 */
function transformDataForChart(
  rows: Record<string, unknown>[],
  config: ChartConfiguration
): TransformedData {
  const { xAxisColumn, yAxisColumns, groupByColumn } = config;

  if (!xAxisColumn || yAxisColumns.length === 0) {
    return { data: [], series: [], dateValues: [] };
  }

  // Collect date values for granularity detection
  const dateValues: Date[] = [];
  for (const row of rows) {
    const date = tryParseDate(row[xAxisColumn]);
    if (date) {
      dateValues.push(date);
    }
  }

  // Determine if X-axis is date-based and detect granularity
  const isDateBased = dateValues.length > 0;
  const granularity = isDateBased ? detectTimeGranularity(dateValues) : "days";

  // Helper to format X value (keeps raw value for non-dates, formats dates)
  const formatX = (value: unknown): string => {
    if (value === null || value === undefined) return "N/A";
    const date = tryParseDate(value);
    if (date) {
      return formatDateByGranularity(date, granularity);
    }
    return String(value);
  };

  // No grouping: use Y columns directly as series
  if (!groupByColumn) {
    const data = rows.map((row) => {
      const point: Record<string, unknown> = {
        [xAxisColumn]: formatX(row[xAxisColumn]),
        // Store raw date for tooltip
        __rawDate: tryParseDate(row[xAxisColumn]),
        __granularity: granularity,
      };
      for (const yCol of yAxisColumns) {
        point[yCol] = toNumber(row[yCol]);
      }
      return point;
    });

    return { data, series: yAxisColumns, dateValues };
  }

  // With grouping: pivot data so each group value becomes a series
  const yCol = yAxisColumns[0]; // Use first Y column when grouping
  const groupValues = new Set<string>();
  const groupedByX = new Map<string, { values: Record<string, number>; rawDate: Date | null }>();

  for (const row of rows) {
    const xValue = formatX(row[xAxisColumn]);
    const rawDate = tryParseDate(row[xAxisColumn]);
    const groupValue = String(row[groupByColumn] ?? "Unknown");
    const yValue = toNumber(row[yCol]);

    groupValues.add(groupValue);

    if (!groupedByX.has(xValue)) {
      groupedByX.set(xValue, { values: {}, rawDate });
    }

    const existing = groupedByX.get(xValue)!;
    // Sum values if there are multiple rows with same x + group
    existing.values[groupValue] = (existing.values[groupValue] ?? 0) + yValue;
  }

  // Convert to array format
  const series = Array.from(groupValues).sort();
  const data = Array.from(groupedByX.entries()).map(([xValue, { values, rawDate }]) => {
    const point: Record<string, unknown> = {
      [xAxisColumn]: xValue,
      __rawDate: rawDate,
      __granularity: granularity,
    };
    for (const group of series) {
      point[group] = values[group] ?? 0;
    }
    return point;
  });

  return { data, series, dateValues };
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function QueryResultsChart({ rows, columns, config }: QueryResultsChartProps) {
  const { xAxisColumn, yAxisColumns, chartType, groupByColumn, stacked } = config;

  // Transform data for charting
  const { data, series, dateValues } = useMemo(
    () => transformDataForChart(rows, config),
    [rows, config]
  );

  // Detect time granularity for the data
  const timeGranularity = useMemo(
    () => (dateValues.length > 0 ? detectTimeGranularity(dateValues) : null),
    [dateValues]
  );

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

  const commonProps = {
    data,
    margin: { top: 10, right: 10, left: 10, bottom: 10 },
  };

  // Determine appropriate angle for X-axis labels based on granularity
  const xAxisAngle = timeGranularity === "hours" || timeGranularity === "seconds" ? -45 : 0;
  const xAxisHeight = xAxisAngle !== 0 ? 60 : undefined;

  const xAxisProps = {
    dataKey: xAxisColumn,
    fontSize: 12,
    tickLine: false,
    tickMargin: 8,
    axisLine: false,
    tick: { fill: "var(--color-text-dimmed)" },
    angle: xAxisAngle,
    textAnchor: xAxisAngle !== 0 ? ("end" as const) : ("middle" as const),
    height: xAxisHeight,
  };

  const yAxisProps = {
    fontSize: 12,
    tickLine: false,
    tickMargin: 8,
    axisLine: false,
    tick: { fill: "var(--color-text-dimmed)" },
    tickFormatter: yAxisFormatter,
  };

  return (
    <ChartContainer config={chartConfig} className="h-full min-h-[300px] w-full">
      {chartType === "bar" ? (
        <BarChart {...commonProps}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis {...xAxisProps} />
          <YAxis {...yAxisProps} />
          <ChartTooltip
            content={<ChartTooltipContent />}
            labelFormatter={tooltipLabelFormatter}
            cursor={{ fill: "var(--color-charcoal-800)", opacity: 0.5 }}
          />
          {series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
          {series.map((s, i) => (
            <Bar
              key={s}
              dataKey={s}
              fill={getSeriesColor(i)}
              stackId={stacked ? "stack" : undefined}
              radius={stacked ? [0, 0, 0, 0] : [4, 4, 0, 0]}
            />
          ))}
        </BarChart>
      ) : (
        <LineChart {...commonProps}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis {...xAxisProps} />
          <YAxis {...yAxisProps} />
          <ChartTooltip content={<ChartTooltipContent />} labelFormatter={tooltipLabelFormatter} />
          {series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
          {series.map((s, i) => (
            <Line
              key={s}
              type="monotone"
              dataKey={s}
              stroke={getSeriesColor(i)}
              strokeWidth={2}
              dot={{ fill: getSeriesColor(i), r: 3 }}
              activeDot={{ r: 5 }}
            />
          ))}
        </LineChart>
      )}
    </ChartContainer>
  );
}

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
