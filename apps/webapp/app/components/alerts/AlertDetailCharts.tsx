import type { ChartBarReferenceArea } from "~/components/primitives/charts/ChartBar";
import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import { Chart, type ChartConfig } from "~/components/primitives/charts/ChartCompound";
import { ActivityBars, EVENT_CHART_COLOR, raiseBucket, type ActivitySeries } from "./ActivityBars";
import { warningLegendItem, WARNING_COLOR, type ChartLegendItem } from "./ChartLegend";
import { observedSilence, type SilenceWindow, type TrailingSilence } from "./alertSilence";
import {
  HEALTH_BUCKET_MS,
  type HealthBandRow,
  type MetricSeriesPoint,
  type QuietWindowBounds,
} from "./alertSeriesTypes";

export const HEALTH_LEGEND: ChartLegendItem[] = [
  { swatch: "line", color: EVENT_CHART_COLOR, label: "Healthy" },
  warningLegendItem("Degraded"),
];

export const HEALTH_WARNING_OVERLAY = {
  threshold: 0.5,
  direction: "below" as const,
  color: WARNING_COLOR,
};

export const HEALTH_CONFIG: ChartConfig = {
  health: { label: "Health", color: EVENT_CHART_COLOR },
};

const HEALTH_LABELS: Record<number, string> = { 0: "Degraded", 1: "Healthy" };

export function healthPoints(bands: HealthBandRow[], current?: 1 | 0 | null) {
  const points = bands.map((b) => ({
    bucket: b.bucket,
    health: b.healthy ? 1 : b.degraded ? 0 : null,
  }));
  if (points.length >= 1) {
    const last = points[points.length - 1]!;
    const width =
      points.length >= 2 ? last.bucket - points[points.length - 2]!.bucket : HEALTH_BUCKET_MS;
    points.push({
      bucket: last.bucket + width,
      health: current === undefined ? last.health : current,
    });
  }
  return points;
}

export function healthTooltipLabel(
  timeLabel: (label: string, payload: any[]) => string,
  lastBucket: number,
  current?: 1 | 0 | null
) {
  return (label: string, payload: any[]) => {
    if (!(payload?.[0]?.payload?.bucket > lastBucket)) return timeLabel(label, payload);
    return current !== undefined ? "Now" : timeLabel(label, [{ payload: { bucket: lastBucket } }]);
  };
}

const RAISE_TICK_MIN_GAP = 0.12;

export function dropTicksNearRaise(ticks: number[], raise: number): number[] {
  const range = Math.max(...ticks) - Math.min(...ticks);
  return ticks.filter((t) => t === raise || Math.abs(t - raise) >= range * RAISE_TICK_MIN_GAP);
}

export function healthAxis(
  bands: HealthBandRow[],
  raisedAt?: Date | null,
  current?: 1 | 0 | null,
  timeZone?: string
) {
  const data = healthPoints(bands, current);
  const { tickFormatter, tooltipLabelFormatter } = buildActivityTimeAxis(
    data,
    undefined,
    undefined,
    timeZone
  );
  const raiseTick = raisedAt ? raiseBucket(bands, raisedAt) : undefined;
  const ticks =
    raiseTick === undefined
      ? undefined
      : dropTicksNearRaise(
          [...new Set([bands[0]!.bucket, raiseTick, bands[bands.length - 1]!.bucket])],
          raiseTick
        );
  return {
    data,
    ticks,
    tooltipLabelFormatter,
    tickFormatter: (value: number) =>
      value === raiseTick ? `▲ raised ${tickFormatter(value)}` : tickFormatter(value),
  };
}

export function HealthActivityChart({
  bands,
  raisedAt,
  current,
  timeZone,
}: {
  bands: HealthBandRow[];
  raisedAt?: Date | null;
  current?: 1 | 0 | null;
  timeZone?: string;
}) {
  const {
    data,
    ticks,
    tickFormatter,
    tooltipLabelFormatter: timeLabel,
  } = healthAxis(bands, raisedAt, current, timeZone);
  const lastBucket = bands[bands.length - 1]?.bucket ?? 0;
  const tooltipLabelFormatter = healthTooltipLabel(timeLabel, lastBucket, current);
  const label = (value: number) => HEALTH_LABELS[value] ?? "";

  return (
    <div className="h-full min-h-0 w-full">
      <Chart.Root
        config={HEALTH_CONFIG}
        data={data}
        dataKey="bucket"
        series={["health"]}
        fillContainer
      >
        <Chart.Line
          lineType="stepAfter"
          showDots={false}
          xAxisProps={{
            type: "number",
            domain: ["dataMin", "dataMax"],
            ...(ticks !== undefined ? { ticks } : {}),
            tickFormatter,
          }}
          yAxisProps={{ domain: [0, 2], ticks: [1], tickFormatter: label }}
          tooltipLabelFormatter={tooltipLabelFormatter}
          tooltipValueFormatter={label}
          warningOverlay={HEALTH_WARNING_OVERLAY}
        />
      </Chart.Root>
    </div>
  );
}

export const ABSENCE_SERIES: ActivitySeries[] = [
  { key: "value", label: "Runs created", color: EVENT_CHART_COLOR },
];

export type { TrailingSilence };

function detailSilence(
  series: MetricSeriesPoint[],
  quietWindowSec: number | undefined,
  trailing?: TrailingSilence
): SilenceWindow | undefined {
  if (series.length === 0 || !quietWindowSec) return undefined;
  return observedSilence(
    series.map((p) => ({ at: p.bucket, count: p.value ?? 0 })),
    quietWindowSec / 60,
    trailing
  );
}

// Route still passes the trailing-window bounds; only its span is used, as the window.
function windowSecOf(bounds: QuietWindowBounds): number | undefined {
  return bounds ? (bounds.x2 - bounds.x1) / 1000 : undefined;
}

function withNowBucket(series: MetricSeriesPoint[], trailing?: TrailingSilence) {
  if (!trailing || series.length < 2) return series;
  const last = series[series.length - 1]!;
  const next = last.bucket + (last.bucket - series[series.length - 2]!.bucket);
  return next <= trailing.now.getTime() ? [...series, { bucket: next, value: 0 }] : series;
}

function absenceView(
  series: MetricSeriesPoint[],
  quietWindowSec: number | undefined,
  trailing?: TrailingSilence
) {
  const data = withNowBucket(series, trailing);
  const silence = detailSilence(data, quietWindowSec, trailing);
  const step = data.length > 1 ? data[1]!.bucket - data[0]!.bucket : 0;
  const bands: { from: number; to: number }[] = [];
  let from = -1;
  for (let i = 0; i <= data.length; i++) {
    const empty = i < data.length && (data[i]!.value ?? 0) === 0;
    if (empty && from === -1) from = i;
    if (!empty && from !== -1) {
      const to = i - 1;
      const long = quietWindowSec !== undefined && (to - from + 1) * step >= quietWindowSec * 1000;
      if (long || (to === data.length - 1 && silence)) bands.push({ from, to });
      from = -1;
    }
  }
  return { data, bands, quiet: bands.length > 0 || !!silence };
}

export function absenceLegend(
  series: MetricSeriesPoint[],
  quietWindowSec: number | undefined,
  trailing?: TrailingSilence
): ChartLegendItem[] {
  return [
    ...ABSENCE_SERIES.map((s): ChartLegendItem => ({
      swatch: "area",
      color: s.color,
      label: s.label,
    })),
    ...(absenceView(series, quietWindowSec, trailing).quiet
      ? [warningLegendItem("Quiet", "area")]
      : []),
  ];
}

export function quietReferenceAreas(
  series: MetricSeriesPoint[],
  quietWindowSec: number | undefined,
  trailing?: TrailingSilence
): ChartBarReferenceArea[] {
  const { data, bands } = absenceView(series, quietWindowSec, trailing);
  return bands.map((band) => ({
    x1: data[band.from]!.bucket,
    x2: data[band.to]!.bucket,
    fill: WARNING_COLOR,
    fillOpacity: 0.06,
    stroke: WARNING_COLOR,
    strokeOpacity: 0.35,
    strokeDasharray: "2 2",
  }));
}

export function AbsenceActivityChart({
  series,
  quietWindow,
  quietWindowSec,
  trailing,
  raisedAt,
  timeZone,
}: {
  series: MetricSeriesPoint[];
  quietWindow?: QuietWindowBounds;
  quietWindowSec?: number;
  trailing?: TrailingSilence;
  raisedAt?: Date | null;
  timeZone?: string;
}) {
  const windowSec = quietWindowSec ?? windowSecOf(quietWindow ?? null);
  const { data } = absenceView(series, windowSec, trailing);
  return (
    <ActivityBars
      data={data}
      series={ABSENCE_SERIES}
      yAxis="count"
      referenceArea={quietReferenceAreas(series, windowSec, trailing)}
      raisedAt={raisedAt}
      timeZone={timeZone}
    />
  );
}
