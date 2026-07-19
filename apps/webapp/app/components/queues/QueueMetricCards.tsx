import { useMemo, type ReactNode } from "react";
import { buildActivityTimeAxis } from "~/components/primitives/charts/activityTimeAxis";
import {
  Chart,
  type ChartConfig,
  type ChartState,
} from "~/components/primitives/charts/ChartCompound";
import { ChartCard } from "~/components/primitives/charts/ChartCard";
import { UsageSparkline } from "~/components/primitives/UsageSparkline";
import {
  useMetricResourceQuery,
  type MetricResourceTimeRange,
} from "~/hooks/useMetricResourceQuery";
import { Paragraph } from "~/components/primitives/Paragraph";
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import { useSearchParams } from "~/hooks/useSearchParam";
import { cn } from "~/utils/cn";

// Shared building blocks for queue-metric UI (queue detail page, task detail page,
// run inspector). All CH-derived data is fetched client-side through useQueueMetric
// so pages render instantly; loaders only supply live counts and identifiers.

export const QUEUE_METRIC_COLORS = {
  running: "var(--color-queues)",
  limit: "#4D525B",
  queued: "var(--color-queues)",
  p50: "#22D3EE",
  p95: "#F59E0B",
  p99: "#EF4444",
  throttled: "#F59E0B",
  ckKeys: "#34D399",
  ckWait: "#F59E0B",
};

export const QUEUE_METRICS_DEFAULT_PERIOD = "1d";

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
  }
) {
  return useMetricResourceQuery(query, {
    ...opts.ids,
    timeRange: opts.timeRange,
    defaultPeriod: opts.defaultPeriod ?? QUEUE_METRICS_DEFAULT_PERIOD,
    queues: [opts.queueName],
    fillGaps: opts.fillGaps,
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

export type QueueMetricSeriesConfig = { key: string; label: string; color: string };

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
  warningOverlay?: { series: string; below: string };
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
}: QueueMetricChartProps) {
  const { rows, showLoading, failed } = useQueueMetric(query, {
    ids,
    timeRange,
    queueName,
    fillGaps,
    defaultPeriod,
  });

  const data = useMemo(() => {
    return rows
      .map((r) => {
        const point: { bucket: number } & Record<string, number> = {
          bucket: clickhouseTimeToMs(r.t),
        };
        for (const s of series) point[s.key] = toNumber(r[s.key]);
        return point;
      })
      .filter((p) => Number.isFinite(p.bucket));
  }, [rows, series]);

  const chartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    for (const s of series) cfg[s.key] = { label: s.label, color: s.color };
    return cfg;
  }, [series]);

  const { tickFormatter, tooltipLabelFormatter } = useMemo(
    () => buildActivityTimeAxis(data),
    [data]
  );

  const state: ChartState = showLoading ? "loading" : failed ? "invalid" : undefined;

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
      />
    </Chart.Root>
  );
}

export function QueueMetricChartCard({
  title,
  info,
  titleAccessory,
  className,
  ...chart
}: QueueMetricChartProps & {
  title: string;
  info?: ReactNode;
  /** Extra content rendered after the info icon inside the title row (e.g. a live readout). */
  titleAccessory?: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ?? "h-64"}>
      <ChartCard
        title={
          info || titleAccessory ? (
            <span className="flex items-center gap-1.5">
              {title}
              {info ? <InfoIconTooltip content={info} contentClassName="max-w-xs" /> : null}
              {titleAccessory}
            </span>
          ) : (
            title
          )
        }
      >
        <QueueMetricChart {...chart} />
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
const SPARKLINE_PERIOD = "30m";

export function QueueSparklineStat({
  title,
  headline,
  headlineClassName,
  query,
  color,
  ids,
  queueName,
  formatPeak,
}: {
  title: string;
  headline: string;
  headlineClassName?: string;
  query: string;
  color: string;
  ids: QueueMetricIds;
  queueName: string;
  formatPeak?: (peak: number) => string;
}) {
  const timeRange: QueueMetricTimeRange = { period: SPARKLINE_PERIOD, from: null, to: null };
  const { rows } = useQueueMetric(query, {
    ids,
    timeRange,
    queueName,
    fillGaps: true,
    defaultPeriod: SPARKLINE_PERIOD,
  });

  const { data, bucketStartMs, bucketIntervalMs, peak } = useMemo(() => {
    const points = rows
      .map((r) => ({ bucket: clickhouseTimeToMs(r.t), v: toNumber(r.v) }))
      .filter((p) => Number.isFinite(p.bucket))
      .sort((a, b) => a.bucket - b.bucket);
    return {
      data: points.map((p) => p.v),
      bucketStartMs: points[0]?.bucket,
      bucketIntervalMs: points.length > 1 ? points[1]!.bucket - points[0]!.bucket : undefined,
      peak: points.reduce((m, p) => Math.max(m, p.v), 0),
    };
  }, [rows]);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-text-dimmed">{title}</span>
        {data.length > 0 && peak > 0 ? (
          <span className="text-xs tabular-nums text-text-dimmed">
            peak {formatPeak ? formatPeak(peak) : peak.toLocaleString()}
          </span>
        ) : null}
      </div>
      <div className={cn("text-xl tabular-nums text-text-bright", headlineClassName)}>
        {headline}
      </div>
      <UsageSparkline
        data={data}
        bucketStartMs={bucketStartMs}
        bucketIntervalMs={bucketIntervalMs}
        color={color}
        chartClassName="h-6 w-full"
        hideTotal
      />
    </div>
  );
}

export function QueueMetricStat({
  label,
  value,
  className,
  loading,
}: {
  label: string;
  value: string;
  className?: string;
  loading?: boolean;
}) {
  return (
    <div className="rounded-sm border border-grid-dimmed bg-background-bright px-3 py-2">
      <div className="text-xs text-text-dimmed">{label}</div>
      {loading ? (
        <div className="mt-1 h-6 w-12 animate-pulse rounded bg-grid-bright/50" />
      ) : (
        <div className={cn("text-2xl tabular-nums text-text-bright", className)}>{value}</div>
      )}
    </div>
  );
}
