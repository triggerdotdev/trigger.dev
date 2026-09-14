import { useEffect, useMemo } from "react";
import { buildActivityTimeAxis } from "./activityTimeAxis";
import { Chart, type ChartConfig, type ChartState } from "./ChartCompound";
import {
  buildMetricPoints,
  METRIC_X_KEY,
  type MetricChartRow,
  type MetricSeriesConfig,
  type MetricXKind,
} from "./metricPoints";

export { toNumber, toTimestampMs } from "./metricPoints";

type MetricChartProps = {
  /** Rows as returned by the metric query (one per bucket, one column per series key). */
  rows: MetricChartRow[];
  series: MetricSeriesConfig[];
  kind: "line" | "bar";
  /** Column holding the x value. */
  xColumn?: string;
  /**
   * Axis type. Defaults to `time` when every x parses as a timestamp and `category` otherwise;
   * a categorical axis plots the raw label and has no time formatting.
   */
  xKind?: MetricXKind;
  /** Stack the series (bars share a stack, lines render as stacked areas). */
  stacked?: boolean;
  state?: ChartState;
  valueFormat?: (value: number) => string;
  /** Show the Chart.Root legend (with per-series totals) below the chart. */
  showLegend?: boolean;
  /** Full range of a time axis, when it is wider than the data — picks the label granularity. */
  timeRange?: { from: number; to: number };
  /** Line only. Recolor a series warning where it drops below another (e.g. started below
   * enqueued). */
  warningOverlay?: { series: string; below: string } | { series: string; atOrAbove: string };
  /**
   * Series whose leading zeros should be back-filled with the first real value. Gauge series that
   * are only emitted while the resource is active (e.g. a concurrency `limit`) read as 0 before the
   * first emission — carry-forward has nothing to carry yet — which draws a false 0→N step. These
   * are config values that existed all along, so carry the first value backward instead.
   */
  carryBackfill?: string[];
  /**
   * Line only. Recolour a series' stroke above a threshold with a gradient split (colour only
   * above the line). `value` sets a constant threshold; `valueFromSeries` reads a (roughly
   * constant) threshold off another series — e.g. the concurrency limit. `series` targets which
   * line is recoloured; the others keep their own colour.
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
  /**
   * Column whose value counts the samples behind the plotted series. Where it is zero the metric
   * has nothing to report, so every series breaks there instead of reading as a real zero. Keep it
   * out of `series` — it is read for this test only, never drawn.
   */
  sampleCountColumn?: string;
};

/** Bare chart (no card chrome) shared by the queue metrics and the agent blocks. */
export function MetricChart({
  rows,
  series,
  kind,
  xColumn = "t",
  xKind,
  stacked,
  state,
  valueFormat,
  showLegend,
  timeRange,
  warningOverlay,
  carryBackfill,
  thresholdStroke,
  onHasDataChange,
  sampleCountColumn,
}: MetricChartProps) {
  const { points, xKind: resolvedXKind } = useMemo(
    () => buildMetricPoints(rows, { series, xColumn, xKind, carryBackfill, sampleCountColumn }),
    [rows, series, xColumn, xKind, carryBackfill, sampleCountColumn]
  );

  const chartConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    for (const s of series) cfg[s.key] = { label: s.label, color: s.color };
    return cfg;
  }, [series]);

  const rangeFrom = timeRange?.from;
  const rangeTo = timeRange?.to;
  const timeAxis = useMemo(() => {
    if (resolvedXKind !== "time") return undefined;
    const rangeMs = rangeFrom != null && rangeTo != null ? rangeTo - rangeFrom : undefined;
    return buildActivityTimeAxis(points, rangeMs, METRIC_X_KEY);
  }, [resolvedXKind, points, rangeFrom, rangeTo]);

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
      for (const p of points) {
        const v = Number(p[thresholdStroke.valueFromSeries]);
        if (Number.isFinite(v) && v > max) max = v;
      }
      value = max > 0 ? max - 0.5 : undefined;
    }
    if (value == null || !Number.isFinite(value)) return undefined;
    return { value, aboveColor: thresholdStroke.aboveColor, series: thresholdStroke.series };
  }, [thresholdStroke, points]);

  // Report data presence so a wrapping card can hide its legend when the chart settles on the
  // "no activity" state. Only report once loaded, so the legend stays put while loading.
  const hasPlottedData = useMemo(
    () => points.some((point) => series.some((s) => point[s.key] != null)),
    [points, series]
  );

  const isLoading = state === "loading";
  useEffect(() => {
    if (!isLoading) onHasDataChange?.(state !== "invalid" && hasPlottedData);
  }, [isLoading, state, hasPlottedData, onHasDataChange]);

  const xAxisProps = timeAxis ? { tickFormatter: timeAxis.tickFormatter } : undefined;
  const yAxisProps = valueFormat ? { tickFormatter: (v: number) => valueFormat(v) } : undefined;

  return (
    <Chart.Root
      config={chartConfig}
      data={points}
      dataKey={METRIC_X_KEY}
      series={series.map((s) => s.key)}
      state={state}
      showLegend={showLegend}
      fillContainer
    >
      {kind === "bar" ? (
        <Chart.Bar
          stackId={stacked ? "a" : undefined}
          xAxisProps={xAxisProps}
          yAxisProps={yAxisProps}
          tooltipLabelFormatter={timeAxis?.tooltipLabelFormatter}
          tooltipValueFormatter={valueFormat}
        />
      ) : (
        <Chart.Line
          lineType="monotone"
          stacked={stacked}
          xAxisProps={xAxisProps}
          yAxisProps={yAxisProps}
          tooltipLabelFormatter={timeAxis?.tooltipLabelFormatter}
          tooltipValueFormatter={valueFormat}
          warningOverlay={warningOverlay}
          thresholdStroke={resolvedThresholdStroke}
        />
      )}
    </Chart.Root>
  );
}
