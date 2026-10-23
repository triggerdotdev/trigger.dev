import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import type { MetricSeriesPoint } from "~/components/alerts/alertSeriesTypes";
import { EVENT_CHART_COLOR, raiseBucket } from "./ActivityBars";
import {
  THRESHOLD_LINE_COLOR,
  WARNING_COLOR,
  warningLegendItem,
  type ChartLegendItem,
} from "./ChartLegend";
import { formatAlertTick } from "./formatAlertTick";
import { evenTimeTicks, niceYAxis, stepDecimals, withRaiseTick } from "./alertAxis";

export { formatAlertTick };

const Y_AXIS_WIDTH = 56;

function axisFor(values: (number | null | undefined)[], threshold: number | null, unit: string) {
  const seriesMax = values.reduce<number>(
    (m, v) => (typeof v === "number" && Number.isFinite(v) && v > m ? v : m),
    0
  );
  const { ticks, domain, step } = niceYAxis(seriesMax, threshold, unit);
  const decimals = stepDecimals(step);
  const format = (value: number) => formatAlertTick(value, unit, domain[1], decimals);
  return { ticks, domain, format };
}

function hasReadings(series: MetricSeriesPoint[]): boolean {
  return series.filter((p) => p.value !== null && p.value !== undefined).length > 1;
}

export function thresholdWarningOverlay(threshold: number | null, operator?: ">" | "<") {
  return threshold === null
    ? undefined
    : {
        threshold,
        direction: operator === "<" ? ("below" as const) : ("above" as const),
        tooltipSwatch: true as const,
        color: WARNING_COLOR,
      };
}

const SERIES_COLORS = [EVENT_CHART_COLOR, "#6366F1", "#EC4899", "#F59E0B", "#10B981"];
const OTHER_COLOR = "var(--color-text-dimmed)";

function orderedSeriesKeys(seriesMap: Map<string, unknown>): string[] {
  const keys = visibleSeriesKeys(seriesMap).filter((k) => k !== "__other__");
  if (seriesMap.has("__other__")) keys.push("__other__");
  return keys;
}

function multiSeriesConfig(keys: string[]): Record<string, { label: string; color: string }> {
  return Object.fromEntries(
    keys.map((key, i) => [
      key,
      {
        label: key === "__other__" ? "Other" : key,
        color: key === "__other__" ? OTHER_COLOR : SERIES_COLORS[i % SERIES_COLORS.length]!,
      },
    ])
  );
}

function thresholdChartParts({
  seriesMap,
  label,
  threshold,
  operator,
}: {
  seriesMap?: Map<string, unknown>;
  label: string;
  threshold: number | null;
  operator?: ">" | "<";
}) {
  const keys = seriesMap ? orderedSeriesKeys(seriesMap) : [];
  const multi = keys.length > 1;
  return {
    config: multi ? multiSeriesConfig(keys) : { value: { label, color: EVENT_CHART_COLOR } },
    overlay: multi ? undefined : thresholdWarningOverlay(threshold, operator),
    referenceLineColor: threshold === null ? undefined : THRESHOLD_LINE_COLOR,
  };
}

export function thresholdChartLegend(input: {
  seriesMap?: Map<string, unknown>;
  label: string;
  threshold: number | null;
  operator?: ">" | "<";
}): ChartLegendItem[] {
  const { config, overlay } = thresholdChartParts(input);
  return [
    ...Object.values(config).map((c): ChartLegendItem => ({ swatch: "line", ...c })),
    ...(overlay
      ? [warningLegendItem(overlay.direction === "below" ? "Below threshold" : "Above threshold")]
      : []),
  ];
}

function AlertChartEmptyState({ height, fill }: { height?: number; fill: boolean }) {
  return (
    <div
      style={fill ? undefined : { height, minHeight: height }}
      className={fill ? "h-full min-h-0 w-full" : "w-full"}
    >
      <Chart.Root config={{}} data={[]} dataKey="bucket" series={["value"]} fillContainer>
        <Chart.Line />
      </Chart.Root>
    </div>
  );
}

export function AlertThresholdChart({
  series,
  threshold,
  height,
  fill = false,
  unit = "",
  label = "Reading",
  operator,
  raisedAt,
  timeZone,
}: {
  series: MetricSeriesPoint[];
  threshold: number | null;
  height?: number;
  fill?: boolean;
  unit?: string;
  label?: string;
  operator?: ">" | "<";
  raisedAt?: Date | null;
  timeZone?: string;
}) {
  if (!hasReadings(series)) {
    return <AlertChartEmptyState height={height} fill={fill} />;
  }

  const data = series.map((p) => ({ bucket: p.bucket, value: p.value }));

  const config: ChartConfig = thresholdChartParts({ label, threshold, operator }).config;

  const { tickFormatter, tooltipLabelFormatter } = buildActivityTimeAxis(
    data,
    undefined,
    undefined,
    timeZone
  );
  const { ticks, domain, format } = axisFor(
    data.map((d) => d.value),
    threshold,
    unit
  );
  const raiseTick = raisedAt ? raiseBucket(data, raisedAt) : undefined;
  const xTicks = withRaiseTick(evenTimeTicks(data.map((d) => d.bucket)), raiseTick);

  return (
    <div
      style={fill ? undefined : { height, minHeight: height }}
      className={fill ? "h-full min-h-0 w-full" : "w-full"}
    >
      <Chart.Root config={config} data={data} dataKey="bucket" series={["value"]} fillContainer>
        <Chart.Line
          lineType="monotone"
          showDots={false}
          referenceLines={
            threshold === null
              ? undefined
              : [
                  {
                    y: threshold,
                    label: `Threshold ${format(threshold)}`,
                    labelPlacement: "outside",
                    color: THRESHOLD_LINE_COLOR,
                  },
                ]
          }
          warningOverlay={thresholdWarningOverlay(threshold, operator)}
          xAxisProps={{
            tickFormatter: (value: number) =>
              value === raiseTick ? `▲ raised ${tickFormatter(value)}` : tickFormatter(value),
            ticks: xTicks,
            interval: 0,
          }}
          yAxisProps={{ tickFormatter: format, width: Y_AXIS_WIDTH, ticks, domain }}
          tooltipLabelFormatter={tooltipLabelFormatter}
          tooltipValueFormatter={format}
        />
      </Chart.Root>
    </div>
  );
}

export function visibleSeriesKeys(seriesMap: Map<string, unknown>): string[] {
  return Array.from(seriesMap.keys()).filter((k) => k !== "__agg__");
}

export function AlertMultiSeriesChart({
  seriesMap,
  threshold,
  height,
  fill = false,
  unit = "",
  label = "Reading",
  showLegend = false,
  operator,
  raisedAt,
  timeZone,
}: {
  seriesMap: Map<string, MetricSeriesPoint[]>;
  threshold: number | null;
  height?: number;
  fill?: boolean;
  unit?: string;
  label?: string;
  showLegend?: boolean;
  operator?: ">" | "<";
  raisedAt?: Date | null;
  timeZone?: string;
}) {
  const keys = orderedSeriesKeys(seriesMap);
  if (keys.length === 0 || keys.every((k) => !hasReadings(seriesMap.get(k) ?? []))) {
    return <AlertChartEmptyState height={height} fill={fill} />;
  }

  if (keys.length === 1) {
    const series = seriesMap.get(keys[0]!)!;
    return (
      <AlertThresholdChart
        series={series}
        threshold={threshold}
        height={height}
        fill={fill}
        unit={unit}
        label={label}
        operator={operator}
        raisedAt={raisedAt}
        timeZone={timeZone}
      />
    );
  }

  const merged: Record<string, unknown>[] = [];
  const firstSeries = seriesMap.get(keys[0]!)!;
  for (let i = 0; i < firstSeries.length; i++) {
    const point: Record<string, unknown> = { bucket: firstSeries[i]!.bucket };
    for (const key of keys) {
      point[key] = seriesMap.get(key)?.[i]?.value ?? null;
    }
    merged.push(point);
  }

  const configEntries = multiSeriesConfig(keys);

  const { tickFormatter, tooltipLabelFormatter } = buildActivityTimeAxis(
    merged,
    undefined,
    undefined,
    timeZone
  );
  const { ticks, domain, format } = axisFor(
    merged.flatMap((row) => keys.map((k) => row[k] as number | null)),
    threshold,
    unit
  );
  const raiseTick = raisedAt ? raiseBucket(firstSeries, raisedAt) : undefined;
  const xTicks = withRaiseTick(evenTimeTicks(merged.map((row) => row.bucket as number)), raiseTick);

  return (
    <div
      style={fill ? undefined : { height, minHeight: height }}
      className={fill ? "h-full min-h-0 w-full" : "w-full"}
    >
      <Chart.Root
        config={configEntries}
        data={merged}
        dataKey="bucket"
        series={keys}
        fillContainer
        showLegend={showLegend}
        legendShowTotal={false}
      >
        <Chart.Line
          lineType="monotone"
          showDots={false}
          referenceLines={
            threshold === null
              ? undefined
              : [
                  {
                    y: threshold,
                    label: `Threshold ${format(threshold)}`,
                    labelPlacement: "outside",
                    color: THRESHOLD_LINE_COLOR,
                  },
                ]
          }
          xAxisProps={{
            tickFormatter: (value: number) =>
              value === raiseTick ? `▲ raised ${tickFormatter(value)}` : tickFormatter(value),
            ticks: xTicks,
            interval: 0,
          }}
          yAxisProps={{ tickFormatter: format, width: Y_AXIS_WIDTH, ticks, domain }}
          tooltipLabelFormatter={tooltipLabelFormatter}
          tooltipValueFormatter={format}
        />
      </Chart.Root>
    </div>
  );
}
