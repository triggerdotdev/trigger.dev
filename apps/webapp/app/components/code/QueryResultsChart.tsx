import type { OutputColumnMetadata } from "@internal/clickhouse";
import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
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
    return { data: [], series: [] };
  }

  // No grouping: use Y columns directly as series
  if (!groupByColumn) {
    const data = rows.map((row) => {
      const point: Record<string, unknown> = {
        [xAxisColumn]: formatXAxisValue(row[xAxisColumn]),
      };
      for (const yCol of yAxisColumns) {
        point[yCol] = toNumber(row[yCol]);
      }
      return point;
    });

    return { data, series: yAxisColumns };
  }

  // With grouping: pivot data so each group value becomes a series
  const yCol = yAxisColumns[0]; // Use first Y column when grouping
  const groupValues = new Set<string>();
  const groupedByX = new Map<string, Record<string, number>>();

  for (const row of rows) {
    const xValue = formatXAxisValue(row[xAxisColumn]);
    const groupValue = String(row[groupByColumn] ?? "Unknown");
    const yValue = toNumber(row[yCol]);

    groupValues.add(groupValue);

    if (!groupedByX.has(xValue)) {
      groupedByX.set(xValue, {});
    }

    const existing = groupedByX.get(xValue)!;
    // Sum values if there are multiple rows with same x + group
    existing[groupValue] = (existing[groupValue] ?? 0) + yValue;
  }

  // Convert to array format
  const series = Array.from(groupValues).sort();
  const data = Array.from(groupedByX.entries()).map(([xValue, values]) => {
    const point: Record<string, unknown> = { [xAxisColumn]: xValue };
    for (const group of series) {
      point[group] = values[group] ?? 0;
    }
    return point;
  });

  return { data, series };
}

function formatXAxisValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "N/A";
  }

  // Handle dates
  if (value instanceof Date) {
    return formatDateForAxis(value);
  }

  // Handle date strings
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return formatDateForAxis(new Date(value));
  }

  return String(value);
}

function formatDateForAxis(date: Date): string {
  // Format as short date
  const month = date.toLocaleString("en-US", { month: "short" });
  const day = date.getDate();
  return `${month} ${day}`;
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
  const { data, series } = useMemo(
    () => transformDataForChart(rows, config),
    [rows, config]
  );

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

  // Validation
  if (!xAxisColumn) {
    return (
      <EmptyState message="Select an X-axis column to display the chart" />
    );
  }

  if (yAxisColumns.length === 0) {
    return (
      <EmptyState message="Select a Y-axis column to display the chart" />
    );
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

  const xAxisProps = {
    dataKey: xAxisColumn,
    fontSize: 12,
    tickLine: false,
    tickMargin: 8,
    axisLine: false,
    tick: { fill: "var(--color-text-dimmed)" },
  };

  const yAxisProps = {
    fontSize: 12,
    tickLine: false,
    tickMargin: 8,
    axisLine: false,
    tick: { fill: "var(--color-text-dimmed)" },
    tickFormatter: (value: number) => formatYAxisValue(value),
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
            cursor={{ fill: "var(--color-charcoal-800)", opacity: 0.5 }}
          />
          {series.length > 1 && (
            <ChartLegend content={<ChartLegendContent />} />
          )}
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
          <ChartTooltip content={<ChartTooltipContent />} />
          {series.length > 1 && (
            <ChartLegend content={<ChartLegendContent />} />
          )}
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

function formatYAxisValue(value: number): string {
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  if (Number.isInteger(value)) {
    return value.toString();
  }
  return value.toFixed(2);
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

