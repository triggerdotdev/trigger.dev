import { buildActivityTimeAxis, dayTicks } from "~/components/primitives/charts/activityTimeAxis";
import type { ChartBarReferenceArea } from "~/components/primitives/charts/ChartBar";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { cn } from "~/utils/cn";
import {
  compactRaiseTicks,
  dropTicksNearRaise,
  raisedAwareTick,
} from "~/components/primitives/charts/VerticalMarker";
import { WARNING_COLOR } from "./ChartLegend";

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

export function raiseBucket(data: { bucket: number }[], raisedAt: Date): number | undefined {
  const at = raisedAt.getTime();
  const first = data[0]?.bucket;
  if (first !== undefined && at < first) {
    const step = data[1] ? data[1].bucket - first : 0;
    return step > 0 && first - at <= step ? first : undefined;
  }
  return data.find(
    (row, index) =>
      row.bucket <= at && (data[index + 1] === undefined || data[index + 1]!.bucket > at)
  )?.bucket;
}

export function raisedLabel(raisedAt: Date, timeZone = "UTC", timeOnly = false): string {
  return raisedAt.toLocaleString("en-US", {
    ...(timeOnly ? {} : { month: "short", day: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  });
}

export function raisedMarker(
  data: { bucket: number }[],
  raisedAt: Date | null | undefined,
  timeZone = "UTC",
  timeOnly = true
) {
  const x = raisedAt ? raiseBucket(data, raisedAt) : undefined;
  if (!raisedAt || x === undefined) return undefined;
  const first = data[0]!.bucket;
  const span = data[data.length - 1]!.bucket - first;
  const at = span > 0 ? (x - first) / span : 0.5;
  const anchor =
    at > 0.85 ? ("end" as const) : at < 0.15 ? ("start" as const) : ("middle" as const);
  return {
    x,
    label: `▲ raised ${raisedLabel(raisedAt, timeZone, timeOnly)}`,
    color: WARNING_COLOR,
    anchor,
  };
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
  compact,
}: {
  compact?: boolean;
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
    timeZone,
    compact
  );
  const config: ChartConfig = Object.fromEntries(
    series.map((s) => [s.key, { label: s.label, color: s.color }])
  );

  const marker = compact ? raisedMarker(data, raisedAt, timeZone) : undefined;
  const tickMarker =
    marker ?? (compact ? undefined : raisedMarker(data, raisedAt, timeZone, false));
  const raiseTick = !compact && raisedAt ? raiseBucket(data, raisedAt) : undefined;
  const compactTicks = marker
    ? compactRaiseTicks(
        data.map((row) => row.bucket),
        dayTicks(data, timeZone),
        marker
      )
    : dayTicks(data, timeZone);
  const ticks = compact
    ? compactTicks
    : raiseTick === undefined
      ? undefined
      : dropTicksNearRaise(
          [...new Set([data[0]!.bucket, raiseTick, data[data.length - 1]!.bucket])],
          raiseTick
        );

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
            ...(tickMarker ? { tick: raisedAwareTick(tickMarker, tickFormatter) } : {}),
            tickFormatter: (value: number) =>
              value === raiseTick && raisedAt
                ? `▲ raised ${raisedLabel(raisedAt, timeZone)}`
                : tickFormatter(value),
          }}
          yAxisProps={yAxis ? Y_AXIS[yAxis] : undefined}
          referenceArea={referenceArea}
          verticalMarker={marker}
          tooltipLabelFormatter={tooltipLabelFormatter}
          tooltipValueFormatter={valueFormatter}
        />
      </Chart.Root>
    </div>
  );
}
