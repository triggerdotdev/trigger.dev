import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import type { ChartBarReferenceArea } from "~/components/primitives/charts/ChartBar";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { cn } from "~/utils/cn";

export const EVENT_CHART_COLOR = "#6c5ce7";

export type ActivityPoint = { bucket: number } & Record<string, number | string | null | undefined>;

export type ActivitySeries = { key: string; label: string; color: string };

export type ActivityYAxisMode = "unit" | "count";

type ActivityYAxis = React.ComponentProps<typeof Chart.Bar>["yAxisProps"];

const Y_AXIS: Record<ActivityYAxisMode, ActivityYAxis> = {
  unit: { hide: true, domain: [0, 1] },
  count: {
    allowDecimals: false,
    domain: [0, (dataMax: number) => Math.max(1, Math.ceil(dataMax * 1.15))],
  },
};

const ACTIVITY_BARS_CLASS =
  "min-h-0 w-full [&_.recharts-cartesian-grid_line]:[stroke-dasharray:3px_3px]";

export function raiseBucket(data: ActivityPoint[], raisedAt: Date): number | undefined {
  const at = raisedAt.getTime();
  return data.find(
    (row, index) =>
      row.bucket <= at && (data[index + 1] === undefined || data[index + 1]!.bucket > at)
  )?.bucket;
}

export function ActivityBars({
  data,
  series,
  yAxis,
  valueFormatter,
  raisedAt,
  referenceArea,
  height,
  timeZone,
}: {
  data: ActivityPoint[];
  series: ActivitySeries[];
  yAxis?: ActivityYAxisMode;
  valueFormatter?: (value: number) => string;
  raisedAt?: Date | null;
  referenceArea?: ChartBarReferenceArea | ChartBarReferenceArea[] | null;
  /** Fixed height; fills the parent when omitted. */
  height?: number;
  timeZone?: string;
}) {
  const { tickFormatter, tooltipLabelFormatter } = buildActivityTimeAxis(
    data,
    undefined,
    undefined,
    timeZone
  );
  const config: ChartConfig = Object.fromEntries(
    series.map((s) => [s.key, { label: s.label, color: s.color }])
  );

  const raiseTick = raisedAt ? raiseBucket(data, raisedAt) : undefined;
  // Chart.Bar has no vertical reference line, so the raise gets its own labelled tick.
  const ticks =
    raiseTick === undefined
      ? undefined
      : [...new Set([data[0]!.bucket, raiseTick, data[data.length - 1]!.bucket])];

  return (
    <div
      className={cn(ACTIVITY_BARS_CLASS, !height && "h-full")}
      style={height ? { height, minHeight: height } : undefined}
    >
      <Chart.Root
        config={config}
        data={data}
        dataKey="bucket"
        series={series.map((s) => s.key)}
        fillContainer
      >
        <Chart.Bar
          stackId="activity"
          barRadius={0}
          xAxisProps={{
            // A `ticks: undefined` key would still override Chart.Bar's auto ticks.
            ...(ticks !== undefined ? { ticks } : {}),
            tickFormatter: (value: number) =>
              value === raiseTick ? `▲ raised ${tickFormatter(value)}` : tickFormatter(value),
          }}
          yAxisProps={yAxis ? Y_AXIS[yAxis] : undefined}
          referenceArea={referenceArea}
          tooltipLabelFormatter={tooltipLabelFormatter}
          tooltipValueFormatter={valueFormatter}
        />
      </Chart.Root>
    </div>
  );
}
