import { getChartColorByName } from "~/components/code/chartColors";
import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { evenTimeTicks, niceYAxis, stepDecimals } from "./alertAxis";
import type { HealthQuerySeries } from "./alertSeriesTypes";
import {
  THRESHOLD_LINE_COLOR,
  WARNING_COLOR,
  warningLegendItem,
  type ChartLegendItem,
} from "./ChartLegend";
import { formatAlertTick } from "./formatAlertTick";

export const HEALTH_LINE_COLORS = ["Purple", "Cyan", "Pink", "Indigo", "Red", "Green"].map(
  getChartColorByName
);

const healthLineColor = (i: number) => HEALTH_LINE_COLORS[i % HEALTH_LINE_COLORS.length];

export const HEALTH_QUERIES_WARNING_OVERLAY = {
  threshold: 100,
  direction: "above" as const,
  color: WARNING_COLOR,
};

export function healthQueriesLegend(series: HealthQuerySeries[]): ChartLegendItem[] {
  return [
    ...series.map((s, i): ChartLegendItem => ({
      swatch: "line",
      color: healthLineColor(i),
      label: s.label,
    })),
    warningLegendItem("Above threshold"),
  ];
}

export function drawnHealthSeries(series: HealthQuerySeries[]): HealthQuerySeries[] {
  return series.filter((s) => s.points.some((p) => p.value !== null));
}

export function AlertHealthQueriesChart({
  series,
  timeZone,
  domain,
  axis,
}: {
  series: HealthQuerySeries[];
  timeZone?: string;
  domain?: [number, number];
  axis?: { ticks?: number[]; tickFormatter: (value: number) => string };
}) {
  const config: ChartConfig = {};
  series.forEach((s, i) => {
    config[s.key] = { label: s.label, color: healthLineColor(i) };
  });

  const buckets = [...new Set(series.flatMap((s) => s.points.map((p) => p.bucket)))].sort(
    (a, b) => a - b
  );
  const data = buckets
    .filter((bucket) => !domain || bucket >= domain[0])
    .map((bucket) => {
      const row: { bucket: number } & Record<string, number | null> = { bucket };
      for (const s of series) row[s.key] = s.points.find((p) => p.bucket === bucket)?.value ?? null;
      return row;
    });

  const peak = Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.value ?? 0)));
  const { ticks, domain: yDomain, step } = niceYAxis(peak, 100, "percent");
  const decimals = stepDecimals(step);
  const format = (value: number) => formatAlertTick(value, "percent", yDomain[1], decimals);
  const { tickFormatter, tooltipLabelFormatter } = buildActivityTimeAxis(
    data,
    domain ? domain[1] - domain[0] : undefined,
    undefined,
    timeZone
  );

  return (
    <div className="h-full min-h-0 w-full">
      <Chart.Root
        config={config}
        data={data}
        dataKey="bucket"
        series={series.map((s) => s.key)}
        fillContainer
      >
        <Chart.Line
          lineType="monotone"
          warningOverlay={HEALTH_QUERIES_WARNING_OVERLAY}
          referenceLines={[
            {
              y: 100,
              label: "Threshold 100%",
              labelPlacement: "outside",
              color: THRESHOLD_LINE_COLOR,
            },
          ]}
          xAxisProps={{
            tickFormatter: axis?.tickFormatter ?? tickFormatter,
            interval: 0,
            ...(domain
              ? {
                  type: "number",
                  domain,
                  ticks: axis ? axis.ticks : evenTimeTicks(data.map((row) => row.bucket)),
                }
              : { ticks: evenTimeTicks(buckets) }),
          }}
          yAxisProps={{ tickFormatter: format, ticks, domain: yDomain }}
          tooltipLabelFormatter={tooltipLabelFormatter}
          tooltipValueFormatter={(value) => `${Math.round(value)}%`}
        />
      </Chart.Root>
    </div>
  );
}
