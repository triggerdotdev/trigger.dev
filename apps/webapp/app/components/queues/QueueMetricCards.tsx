import { useEffect, useMemo, useState, type ReactNode } from "react";
import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import {
  Chart,
  type ChartConfig,
  type ChartState,
} from "~/components/primitives/charts/ChartCompound";
import { ChartCard } from "~/components/primitives/charts/ChartCard";
import {
  useMetricResourceQuery,
  type MetricResourceTimeRange,
} from "~/hooks/useMetricResourceQuery";
import { Paragraph } from "~/components/primitives/Paragraph";
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import { useSearchParams } from "~/hooks/useSearchParam";
import { QUEUE_METRICS_DEFAULT_PERIOD } from "~/components/queues/queueMetricsPeriod";
import {} from "~/utils/numberFormatter";

// Shared building blocks for queue-metric UI (queue detail page, task detail page,
// run inspector). All CH-derived data is fetched client-side through useQueueMetric
// so pages render instantly; loaders only supply live counts and identifiers.

export const QUEUE_METRIC_COLORS = {
  running: "var(--color-queues-chart)",
  limit: "var(--color-queues-chart-ref)",
  queued: "var(--color-queues-chart)",
  p50: "#22D3EE",
  p95: "#F59E0B",
  p99: "#EF4444",
  throttled: "#F59E0B",
  ckKeys: "#34D399",
  ckWait: "#F59E0B",
};

export type QueueMetricIds = {
  organizationId: string;
  projectId: string;
  environmentId: string;
};

export type QueueMetricTimeRange = MetricResourceTimeRange;

export function useQueueMetric(
  query: string,
  opts: {
    ids: QueueMetricIds;
    timeRange: QueueMetricTimeRange;
    queueName: string;
    fillGaps?: boolean;
    /** Match the host page's TimeFilter default (e.g. "7d" on task detail). */
    defaultPeriod?: string;
    /** Poll ClickHouse on this cadence (ms). Omit to use the query's default interval. */
    refreshIntervalMs?: number;
    /** Floor for the bucket width, for series too sparse to read at the range's natural width. */
    minBucketSeconds?: number;
  }
) {
  return useMetricResourceQuery(query, {
    ...opts.ids,
    timeRange: opts.timeRange,
    defaultPeriod: opts.defaultPeriod ?? QUEUE_METRICS_DEFAULT_PERIOD,
    queues: [opts.queueName],
    fillGaps: opts.fillGaps,
    minBucketSeconds: opts.minBucketSeconds,
    refreshIntervalMs: opts.refreshIntervalMs,
  });
}

export function toNumber(value: number | string | null | undefined): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function clickhouseTimeToMs(value: unknown): number {
  const s = String(value).replace(" ", "T");
  return Date.parse(s.endsWith("Z") ? s : `${s}Z`);
}

export function formatWaitMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

type QueueMetricSeriesConfig = { key: string; label: string; color: string };

type QueueMetricChartProps = {
  query: string;
  series: QueueMetricSeriesConfig[];
  ids: QueueMetricIds;
  timeRange: QueueMetricTimeRange;
  queueName: string;
  valueFormat?: (value: number) => string;
  fillGaps?: boolean;
  defaultPeriod?: string;
  /** Recolor a series warning where it drops below another (e.g. started below enqueued). */
  warningOverlay?: { series: string; below: string } | { series: string; atOrAbove: string };
  /**
   * Series whose leading zeros should be back-filled with the first real value. Gauge series that
   * are only emitted while the queue is active (e.g. the concurrency `limit`) read as 0 before the
   * first emission — carry-forward has nothing to carry yet — which draws a false 0→N step. These
   * are config values that existed all along, so carry the first value backward instead.
   */
  carryBackfill?: string[];
  /** Show the series legend below the chart (use for multi-series charts). */
  showLegend?: boolean;
  /**
   * Recolour a series' stroke above a threshold with a gradient split (colour only above the
   * line). `value` sets a constant threshold; `valueFromSeries` reads a (roughly constant)
   * threshold off another series — e.g. the concurrency limit. `series` targets which line is
   * recoloured; the others keep their own colour.
   */
  thresholdStroke?: {
    aboveColor: string;
    series?: string;
    value?: number;
    valueFromSeries?: string;
  };
  /** Reports whether the chart has data to plot (false once it settles on the "no activity" state),
   * so a wrapping card can hide the legend to match. */
  onHasDataChange?: (hasData: boolean) => void;
  /** Floor for the bucket width, for series too sparse to read at the range's natural width. */
  minBucketSeconds?: number;
  /**
   * Column whose value counts the samples behind the plotted series. Where it is zero the metric
   * has nothing to report, so every series breaks there instead of reading as a real zero. Keep it
   * out of `series` — it is read for this test only, never drawn.
   */
  sampleCountColumn?: string;
};

// Bare chart (no card chrome) so it can live inside a shared card, e.g. a tabbed panel.
export function QueueMetricChart({
  query,
  series,
  ids,
  timeRange,
  queueName,
  valueFormat,
  fillGaps,
  defaultPeriod,
  warningOverlay,
  carryBackfill,
  thresholdStroke,
  onHasDataChange,
  minBucketSeconds,
  sampleCountColumn,
}: QueueMetricChartProps) {
  const { rows, showLoading, failed } = useQueueMetric(query, {
    ids,
    timeRange,
    queueName,
    fillGaps,
    defaultPeriod,
    minBucketSeconds,
  });

  const data = useMemo(() => {
    const points = rows
      .map((r) => {
        const point: { bucket: number } & Record<string, number | null> = {
          bucket: clickhouseTimeToMs(r.t),
        };
        const hasSamples = sampleCountColumn ? toNumber(r[sampleCountColumn]) > 0 : true;
        for (const s of series) point[s.key] = hasSamples ? toNumber(r[s.key]) : null;
        return point;
      })
      .filter((p) => Number.isFinite(p.bucket));

    // Back-fill leading zeros for config gauges (see `carryBackfill`): find the first positive
    // value and carry it back over the earlier buckets so the line doesn't start at a false 0.
    if (carryBackfill?.length) {
      for (const key of carryBackfill) {
        const first = points.findIndex((p) => toNumber(p[key]) > 0);
        if (first > 0) {
          const value = points[first]![key]!;
          for (let i = 0; i < first; i++) points[i]![key] = value;
        }
      }
    }
    return points;
  }, [rows, series, carryBackfill, sampleCountColumn]);

  const chartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    for (const s of series) cfg[s.key] = { label: s.label, color: s.color };
    return cfg;
  }, [series]);

  const { tickFormatter, tooltipLabelFormatter } = useMemo(
    () => buildActivityTimeAxis(data),
    [data]
  );

  // Resolve the threshold value: a constant, or the max of another series (e.g. the limit line,
  // which is effectively constant). A gradient split then colours the target series only above it.
  // `valueFromSeries` targets integer-count series (concurrency limit), so split half a unit below
  // the limit — that way the line renders warning *at or above* the limit (saturated), matching
  // "turns yellow at the limit", rather than only when it strictly exceeds it.
  const resolvedThresholdStroke = useMemo(() => {
    if (!thresholdStroke) return undefined;
    let value = thresholdStroke.value;
    if (value == null && thresholdStroke.valueFromSeries) {
      let max = -Infinity;
      for (const p of data) {
        const v = Number(p[thresholdStroke.valueFromSeries]);
        if (Number.isFinite(v) && v > max) max = v;
      }
      value = max > 0 ? max - 0.5 : undefined;
    }
    if (value == null || !Number.isFinite(value)) return undefined;
    return { value, aboveColor: thresholdStroke.aboveColor, series: thresholdStroke.series };
  }, [thresholdStroke, data]);

  const state: ChartState = showLoading ? "loading" : failed ? "invalid" : undefined;

  // Report data presence so a wrapping card can hide its legend when the chart settles on the
  // "no activity" state. Only report once loaded, so the legend stays put while loading.
  const hasPlottedData = useMemo(
    () => data.some((point) => series.some((s) => point[s.key] != null)),
    [data, series]
  );

  useEffect(() => {
    if (!showLoading) onHasDataChange?.(!failed && hasPlottedData);
  }, [showLoading, failed, hasPlottedData, onHasDataChange]);

  return (
    <Chart.Root
      config={chartConfig}
      data={data}
      dataKey="bucket"
      series={series.map((s) => s.key)}
      state={state}
      fillContainer
    >
      <Chart.Line
        lineType="monotone"
        xAxisProps={{ tickFormatter }}
        yAxisProps={valueFormat ? { tickFormatter: (v: number) => valueFormat(v) } : undefined}
        tooltipLabelFormatter={tooltipLabelFormatter}
        tooltipValueFormatter={valueFormat}
        warningOverlay={warningOverlay}
        thresholdStroke={resolvedThresholdStroke}
      />
    </Chart.Root>
  );
}

export function QueueMetricChartCard({
  title,
  info,
  titleAccessory,
  className,
  extraLegend,
  ...chart
}: QueueMetricChartProps & {
  title: string;
  info?: ReactNode;
  /** Extra content rendered after the info icon inside the title row (e.g. a live readout). */
  titleAccessory?: ReactNode;
  className?: string;
  /** Extra legend entries appended after the series — e.g. a warning state that isn't its own
   * series (the orange "over threshold" colour). */
  extraLegend?: Array<{ color: string; label: string }>;
}) {
  // Hide the legend once the chart settles on the "no activity" state (reported by the chart).
  const [hasData, setHasData] = useState(true);
  return (
    <div className={className ?? "h-64"}>
      <ChartCard
        title={
          <span className="flex flex-col gap-1">
            <span className="flex items-center gap-1">
              {title}
              {info ? (
                <InfoIconTooltip
                  content={info}
                  contentClassName="max-w-[230px]"
                  disableHoverableContent
                />
              ) : null}
              {titleAccessory}
            </span>
            {/* Inline legend below the title (swatch + label per series), matching the list-page
                charts — instead of the Chart.Root legend with per-series totals. */}
            {chart.showLegend &&
            hasData &&
            (chart.series.length > 0 || (extraLegend?.length ?? 0) > 0) ? (
              <span className="flex flex-wrap items-center gap-2">
                {chart.series.map((s) => (
                  <span
                    key={s.key}
                    className="flex items-center gap-1 text-xs font-normal text-text-dimmed"
                  >
                    <span className="size-2.5 rounded-[2px]" style={{ backgroundColor: s.color }} />
                    {s.label}
                  </span>
                ))}
                {extraLegend?.map((e) => (
                  <span
                    key={e.label}
                    className="flex items-center gap-1 text-xs font-normal text-text-dimmed"
                  >
                    <span className="size-2.5 rounded-[2px]" style={{ backgroundColor: e.color }} />
                    {e.label}
                  </span>
                ))}
              </span>
            ) : null}
          </span>
        }
      >
        <QueueMetricChart {...chart} onHasDataChange={setHasData} />
      </ChartCard>
    </div>
  );
}

export type QueueLiveCounts = { queued: number; running: number };

// Compact two-line stat block for task detail sidebars: live counts from the loader,
// then delay p95 + peak backlog over the page's TimeFilter range.
export function QueueSidebarStats({
  live,
  ids,
  queueName,
  defaultPeriod,
}: {
  live: QueueLiveCounts;
  ids: QueueMetricIds;
  queueName: string;
  defaultPeriod?: string;
}) {
  const { value } = useSearchParams();
  const timeRange: QueueMetricTimeRange = {
    period: value("period") ?? null,
    from: value("from") ?? null,
    to: value("to") ?? null,
  };

  const { rows, showLoading } = useQueueMetric(
    `SELECT max(max_queued) AS peak_queued,\n  round(quantilesMerge(0.5, 0.9, 0.95, 0.99)(wait_quantiles)[3]) AS worst_p95\nFROM queue_metrics`,
    { ids, timeRange, queueName, defaultPeriod }
  );
  const row = rows[0];
  const worstP95 = row ? toNumber(row.worst_p95) : 0;
  const peakQueued = row ? toNumber(row.peak_queued) : 0;

  return (
    <>
      <Paragraph variant="extra-small" className="tabular-nums text-text-dimmed">
        Queued now {live.queued.toLocaleString()} · Running now {live.running.toLocaleString()}
      </Paragraph>
      <Paragraph variant="extra-small" className="tabular-nums text-text-dimmed">
        {showLoading || !row
          ? "…"
          : `Delay p95 ${worstP95 > 0 ? formatWaitMs(worstP95) : "–"} · Peak backlog ${peakQueued.toLocaleString()}`}
      </Paragraph>
    </>
  );
}

// A compact stat card with a recent trend sparkline underneath, for the run inspector.
// The headline is a live "now" value from the loader; the sparkline pulls its own series.
