import { useMemo } from "react";
import { buildActivityTimeAxis, dayTicks } from "~/components/primitives/charts/activityTimeAxis";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { yAxisWidthForLabel } from "~/components/primitives/charts/useYAxisWidth";
import {
  compactRaiseTicks,
  raisedAwareTick,
  type VerticalMarker,
} from "~/components/primitives/charts/VerticalMarker";

type TileChartProps = {
  data: Array<Record<string, unknown>>;
  series: Array<{ key: string; label: string; color: string }>;
  referenceLines?: Array<{
    y: number;
    label?: string;
    labelPlacement?: "inside" | "outside";
  }>;
  yDomain?: [number, (dataMax: number) => number];
  dateOnlyAxis?: boolean;
  verticalMarker?: VerticalMarker;
  thresholdStroke?: { value: number; aboveColor: string };
  warningOverlay?: React.ComponentProps<typeof Chart.Line>["warningOverlay"];
  formatAxis?: (value: number) => string;
  formatValue?: (value: number) => string;
};

export function MetricTileChart({
  data,
  series,
  referenceLines,
  thresholdStroke,
  warningOverlay,
  formatAxis,
  formatValue,
  yDomain,
  dateOnlyAxis,
  verticalMarker,
}: TileChartProps) {
  const config = useMemo<ChartConfig>(
    () => Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }])),
    [series]
  );
  const { tickFormatter, tooltipLabelFormatter } = buildActivityTimeAxis(
    data,
    undefined,
    undefined,
    undefined,
    dateOnlyAxis
  );
  const dataMax = Math.max(
    0,
    ...data.flatMap((row) => series.map((s) => Number(row[s.key]))).filter(Number.isFinite)
  );
  const yAxisProps =
    formatAxis || yDomain
      ? {
          ...(formatAxis ? { tickFormatter: formatAxis } : {}),
          ...(yDomain ? { domain: yDomain } : {}),
          ...(formatAxis && yDomain
            ? { width: yAxisWidthForLabel(formatAxis(yDomain[1](dataMax))) }
            : {}),
        }
      : undefined;

  return (
    <Chart.Root
      config={config}
      data={data}
      dataKey="bucket"
      series={series.map((s) => s.key)}
      fillContainer
    >
      <Chart.Line
        showDots={false}
        verticalMarker={verticalMarker}
        referenceLines={referenceLines}
        thresholdStroke={thresholdStroke}
        warningOverlay={warningOverlay}
        xAxisProps={{
          tickFormatter,
          ...(verticalMarker
            ? {
                ticks: compactRaiseTicks(
                  data.map((row) => row.bucket as number),
                  dayTicks(data),
                  verticalMarker
                ),
                tick: raisedAwareTick(verticalMarker, tickFormatter),
              }
            : dateOnlyAxis
              ? { ticks: dayTicks(data) }
              : {}),
        }}
        yAxisProps={yAxisProps}
        tooltipLabelFormatter={tooltipLabelFormatter}
        tooltipValueFormatter={formatValue}
      />
    </Chart.Root>
  );
}
