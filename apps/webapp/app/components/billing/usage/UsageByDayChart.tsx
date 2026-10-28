import type { ChartConfig } from "~/components/primitives/charts/Chart";
import { Chart } from "~/components/primitives/charts/ChartCompound";
import type { UsageChartRow } from "~/utils/billingUsageChart";

export type UsageChartSeries = { key: string; label: string; color: string };

const tooltipDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

function dayOfMonth(value: string) {
  if (!value) return "";
  return String(new Date(value).getUTCDate());
}

function tooltipLabel(value: string) {
  if (!value) return "";
  return tooltipDateFormatter.format(new Date(value));
}

export function UsageByDayChart({
  data,
  series,
  yTickFormatter,
  valueFormatter,
  isLoading = false,
}: {
  data: UsageChartRow[];
  series: UsageChartSeries[];
  yTickFormatter: (value: number) => string;
  valueFormatter: (value: number) => string;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <div
        role="status"
        aria-label="Loading"
        className="h-80 animate-pulse rounded-sm bg-background-raised"
      />
    );
  }

  const config = Object.fromEntries(
    series.map((entry) => [entry.key, { label: entry.label, color: entry.color }])
  ) satisfies ChartConfig;
  const isStacked = series.length > 1;

  return (
    <div className="h-80">
      <Chart.Root
        config={config}
        data={data}
        dataKey="date"
        series={series.map((entry) => entry.key)}
        showLegend={isStacked}
        legendValueFormatter={valueFormatter}
        enableZoom={false}
        fillContainer
      >
        <Chart.Bar
          stackId={isStacked ? "usage" : undefined}
          xAxisProps={{ tickFormatter: dayOfMonth }}
          yAxisProps={{ tickFormatter: yTickFormatter, allowDecimals: true }}
          tooltipLabelFormatter={tooltipLabel}
          tooltipValueFormatter={valueFormatter}
        />
      </Chart.Root>
    </div>
  );
}
