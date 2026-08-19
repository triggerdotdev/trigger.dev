import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
  type XAxisProps,
  type YAxisProps,
} from "recharts";
import { ChartTooltip, ChartTooltipContent } from "~/components/primitives/charts/Chart";
import TooltipPortal from "~/components/primitives/TooltipPortal";
import { CHART_MARGIN } from "./ChartBar";
import { useChartContext } from "./ChartContext";
import { ChartLineInvalid, ChartLineLoading, ChartLineNoData } from "./ChartLoading";
import { useHasNoData } from "./ChartRoot";
import { useChartSync } from "./ChartSyncContext";
import { defaultYAxisTickFormatter, useYAxisWidth } from "./useYAxisWidth";
// Legend is now rendered by ChartRoot outside the chart container

// Dashed line mirroring the hovered x across synced charts.
const SYNC_LINE_COLOR = "var(--color-text-faint)";

// Data key the warning overlay line is plotted under. Injected into the render data only; never
// added to config/series, so it stays out of the legend, no-data check and series totals. Deduped
// out of the tooltip so a hovered bucket shows one value, not the base + overlay retrace.
const WARNING_OVERLAY_KEY = "__warningOverlay";

type CurveType =
  | "basis"
  | "basisClosed"
  | "basisOpen"
  | "linear"
  | "linearClosed"
  | "natural"
  | "monotoneX"
  | "monotoneY"
  | "monotone"
  | "step"
  | "stepBefore"
  | "stepAfter";

/** While drag-to-zooming, show the selected From/To range instead of hovered values. */
function ZoomRangeTooltip({ active, from, to }: { active?: boolean; from: string; to: string }) {
  if (!active) return null;
  return (
    <TooltipPortal active={active}>
      <div className="grid grid-cols-[auto_auto] gap-x-2 gap-y-1 rounded-lg border border-grid-bright bg-background-bright px-2.5 py-1.5 text-xs shadow-xl">
        <span className="text-right text-text-dimmed">From:</span>
        <span className="tabular-nums text-text-bright">{from}</span>
        <span className="text-right text-text-dimmed">To:</span>
        <span className="tabular-nums text-text-bright">{to}</span>
      </div>
    </TooltipPortal>
  );
}

// Stable module-level tooltip for warning-overlay charts: drops the overlay's retraced entry so a
// hovered bucket shows one value (base), not base + overlay. Defined at module scope (not inline in
// the renderer) so recharts reconciles it in place across hover re-renders instead of remounting
// the portaled tooltip — the latter caused a flicker while moving along the line.
function OverlayFilteredTooltip(props: any) {
  return (
    <ChartTooltipContent
      {...props}
      payload={props.payload?.filter((p: any) => p.dataKey !== WARNING_OVERLAY_KEY)}
    />
  );
}

// Stable module-level tooltip for the stacked area chart: keeps the line-style indicator the
// stacked view has always used (ChartTooltipContent otherwise defaults to a dot). Module-level for
// the same reconcile-in-place reason as OverlayFilteredTooltip — an inline element would remount
// the portaled tooltip on every hover re-render and flicker.
function StackedAreaTooltip(props: any) {
  return <ChartTooltipContent {...props} indicator="line" />;
}

// ============================================================================
// COMPOUND COMPONENT API
// ============================================================================

export type ChartLineRendererProps = {
  /** Line curve type */
  lineType?: CurveType;
  /** Custom X-axis props to merge with defaults */
  xAxisProps?: Partial<XAxisProps>;
  /** Custom Y-axis props to merge with defaults */
  yAxisProps?: Partial<YAxisProps>;
  /** Render as stacked area chart instead of line chart */
  stacked?: boolean;
  /** Custom tooltip label formatter */
  tooltipLabelFormatter?: (label: string, payload: any[]) => string;
  /** Optional formatter for numeric tooltip values (e.g. bytes, duration) */
  tooltipValueFormatter?: (value: number) => string;
  /** Draw a dot at each data point. Defaults to true; turn off for dense/compact charts. */
  showDots?: boolean;
  /**
   * Horizontal reference lines (e.g. limits); the y-domain extends to include them.
   *
   * `labelPlacement` controls where the label sits relative to the plot:
   * - `"inside"` (default): right-aligned just below the line, inside the plot area.
   * - `"outside"`: in the right gutter at the line's y. The chart's right margin is widened
   *   automatically so outside labels are not clipped by the SVG viewport.
   */
  referenceLines?: Array<{
    y: number;
    label?: string;
    color?: string;
    labelPlacement?: "inside" | "outside";
  }>;
  /**
   * Recolor the stroke above a threshold value (e.g. an over-limit warning). The y-domain is
   * pinned so the gradient split lines up exactly with the plotted values and reference lines.
   * Single-series (non-stacked) line charts only.
   *
   * The gradient offset is derived from the plotted line's own value range (objectBoundingBox maps
   * 0..1 to the path's bounding box, not the y-axis), so the colour change lands exactly at the
   * threshold value however the domain is padded for reference lines. `series` targets which line
   * the gradient applies to (others keep their own colour); defaults to the first series.
   */
  thresholdStroke?: { value: number; aboveColor: string; series?: string };
  /**
   * Per-bucket warning recolour: a series is retraced in the warning colour only across buckets
   * where it crosses a limit — either strictly above a constant `threshold` (single-series case,
   * applied to the first series), or where one series drops below another (`series` below `below`,
   * e.g. started < enqueued = "not keeping up"). The mask extends one bucket forward so a lone
   * crossing still yields a visible segment. Unlike {@link thresholdStroke}'s gradient split,
   * non-crossing buckets always stay the base colour. The overlay is excluded from the legend and
   * deduped out of the tooltip. Non-stacked line charts only.
   */
  warningOverlay?:
    | { threshold: number; color?: string }
    | { series: string; below: string; color?: string }
    | { series: string; atOrAbove: string; color?: string };
  /** Width injected by ResponsiveContainer */
  width?: number;
  /** Height injected by ResponsiveContainer */
  height?: number;
};

/** Font size used for reference-line labels; also used to size the outside-label gutter. */
const REFERENCE_LABEL_FONT_SIZE = 10;

/**
 * Reference-line label (recharts injects viewBox).
 * - `"inside"`: right-aligned just below the line, inside the plot.
 * - `"outside"`: left-aligned in the right gutter, vertically centered on the line.
 */
function ReferenceLineLabel({
  viewBox,
  value,
  placement = "inside",
}: {
  viewBox?: { x: number; y: number; width: number };
  value: string;
  placement?: "inside" | "outside";
}) {
  if (!viewBox) return null;
  if (placement === "outside") {
    return (
      <text
        x={viewBox.x + viewBox.width + 6}
        y={viewBox.y}
        dominantBaseline="middle"
        textAnchor="start"
        fill="#878C99"
        fontSize={REFERENCE_LABEL_FONT_SIZE}
      >
        {value}
      </text>
    );
  }
  return (
    <text
      x={viewBox.x + viewBox.width - 4}
      y={viewBox.y + 12}
      textAnchor="end"
      fill="#878C99"
      fontSize={REFERENCE_LABEL_FONT_SIZE}
    >
      {value}
    </text>
  );
}

/**
 * Extra right margin (px) needed so outside reference-line labels aren't clipped by the SVG
 * viewport. Estimates label width from character count; returns 0 when no label is outside-placed.
 */
function outsideLabelGutter(referenceLines: ChartLineRendererProps["referenceLines"]): number {
  const outside = (referenceLines ?? []).filter((l) => l.labelPlacement === "outside" && l.label);
  if (outside.length === 0) return 0;
  const maxChars = Math.max(...outside.map((l) => l.label!.length));
  // ~0.62em per char at this font size, plus padding on both sides of the label.
  return Math.ceil(maxChars * REFERENCE_LABEL_FONT_SIZE * 0.62) + 12;
}

/**
 * Line chart renderer for the compound component system.
 * Must be used within a Chart.Root.
 *
 * When wrapped in a <ChartSyncProvider>, participates in the group's shared hover
 * indicator and drag-to-zoom (mirrors Chart.Bar; a no-op when no provider is present).
 *
 * @example
 * ```tsx
 * <Chart.Root config={config} data={data} dataKey="day">
 *   <Chart.Line type="step" />
 *   <Chart.Legend simple />
 * </Chart.Root>
 * ```
 */
export function ChartLineRenderer({
  lineType = "step",
  xAxisProps: xAxisPropsProp,
  yAxisProps: yAxisPropsProp,
  stacked = false,
  tooltipLabelFormatter,
  tooltipValueFormatter,
  showDots = true,
  referenceLines,
  thresholdStroke,
  warningOverlay,
  width,
  height,
}: ChartLineRendererProps) {
  const {
    config,
    data,
    dataKey,
    dataKeys: _dataKeys,
    visibleSeries,
    state,
    highlight,
    setActivePayload,
    showLegend,
  } = useChartContext();
  const hasNoData = useHasNoData();
  const sync = useChartSync();
  // Strip the colons React injects (":r1:") so the id is safe inside an SVG url(#…) reference.
  const gradientId = `line-threshold-${useId().replace(/:/g, "")}`;
  const yAxisTickFormatter = yAxisPropsProp?.tickFormatter ?? defaultYAxisTickFormatter;
  const computedYAxisWidth = useYAxisWidth(data, visibleSeries, yAxisTickFormatter);

  // Render loading/error states
  if (state === "loading") {
    return <ChartLineLoading />;
  } else if (state === "noData" || hasNoData) {
    return <ChartLineNoData />;
  } else if (state === "invalid") {
    return <ChartLineInvalid />;
  }

  const xAxisConfig = {
    dataKey,
    tickLine: false,
    axisLine: false,
    tickMargin: 10,
    // Keep every x-axis label visible at all times, including on hover. Previously the axis
    // collapsed to just the first + last tick while the tooltip was active.
    interval: "preserveStartEnd" as const,
    tick: {
      fill: "var(--color-text-dimmed)",
      fontSize: 11,
      style: { fontVariantNumeric: "tabular-nums" },
    },
    ...xAxisPropsProp,
  };

  // A threshold stroke needs an exact, fixed y-domain so the gradient split aligns with the
  // plotted values and the reference lines. Compute it from the data + reference/threshold ys.
  let thresholdActive = false;
  let thresholdOffset = 0;
  if (thresholdStroke && !stacked) {
    thresholdActive = true;
    // The gradient is objectBoundingBox — its 0..1 maps to the plotted line's own bounding box
    // (lineMax at the top, lineMin at the bottom), NOT the y-axis. So derive the split from the
    // target line's value range: offset = (lineMax - threshold) / (lineMax - lineMin) lands the
    // colour change exactly at the threshold value's pixel, whatever the axis domain is. That means
    // we don't pin the domain (which coarsened the ticks) — it auto-scales as usual.
    const gradientKey = thresholdStroke.series ?? visibleSeries[0];
    let lineMin = Infinity;
    let lineMax = -Infinity;
    for (const row of data) {
      const v = Number(row[gradientKey]);
      if (Number.isFinite(v)) {
        if (v < lineMin) lineMin = v;
        if (v > lineMax) lineMax = v;
      }
    }
    if (!Number.isFinite(lineMin)) {
      lineMin = 0;
      lineMax = thresholdStroke.value;
    }
    const range = lineMax - lineMin;
    thresholdOffset =
      range > 0
        ? Math.min(1, Math.max(0, (lineMax - thresholdStroke.value) / range))
        : lineMax >= thresholdStroke.value
          ? 0
          : 1;
  }

  // Per-bucket warning overlay: single-series line charts only. Retrace the primary series in the
  // warning colour, non-null only across over-threshold stretches. Include the immediate neighbours
  // of an over-threshold bucket (both endpoints of a segment must be non-null), so the crossing
  // segment on BOTH sides is drawn — the colour change tracks the axis crossing symmetrically, and
  // a lone over-threshold bucket still yields a visible segment.
  const overlayKey =
    warningOverlay && !stacked
      ? "series" in warningOverlay
        ? warningOverlay.series
        : visibleSeries[0]
      : undefined;
  const overlayActive = overlayKey != null;
  const chartData = overlayActive
    ? data.map((row, i) => {
        const isOver = (r: (typeof data)[number] | undefined) => {
          if (!r) return false;
          const v = Number(r[overlayKey]);
          if (!Number.isFinite(v)) return false;
          if ("below" in warningOverlay!) {
            // "Not keeping up": the series dips below its companion (e.g. started < enqueued).
            const b = Number(r[warningOverlay.below]);
            return Number.isFinite(b) && v < b;
          }
          if ("atOrAbove" in warningOverlay!) {
            // "At the limit": the series reaches or exceeds its companion (e.g. running >= limit).
            const b = Number(r[warningOverlay.atOrAbove]);
            return Number.isFinite(b) && b > 0 && v >= b;
          }
          return v > warningOverlay!.threshold;
        };
        const inOverlay = isOver(data[i - 1]) || isOver(row) || isOver(data[i + 1]);
        return { ...row, [WARNING_OVERLAY_KEY]: inOverlay ? row[overlayKey] : null };
      })
    : data;

  const yAxisConfig = {
    axisLine: false,
    tickLine: false,
    tickMargin: 8,
    width: computedYAxisWidth,
    tick: {
      fill: "var(--color-text-dimmed)",
      fontSize: 11,
      style: { fontVariantNumeric: "tabular-nums" },
    },
    tickFormatter: yAxisTickFormatter,
    ...yAxisPropsProp,
  };

  // Widen the right margin only when a reference line is outside-labeled, so charts without
  // outside labels keep their existing geometry.
  const rightGutter = outsideLabelGutter(referenceLines);
  const chartMargin =
    rightGutter > 0
      ? { ...CHART_MARGIN, right: Math.max(CHART_MARGIN.right, rightGutter) }
      : CHART_MARGIN;

  // Handle mouse leave to also reset highlight and any synced hover/zoom drag.
  const handleMouseLeave = () => {
    highlight.setTooltipActive(false);
    highlight.reset();
    sync?.setActiveX(null);
    sync?.cancelZoom();
  };

  // Synced hover + drag-to-zoom state (mirrors Chart.Bar; all no-ops without a provider).
  const syncActiveX = sync?.activeX ?? null;
  const syncZoomSelection = sync?.zoomSelection ?? null;
  const bucketWidthMs = data.length >= 2 ? Number(data[1][dataKey]) - Number(data[0][dataKey]) : 0;
  const formatZoomEdge = (v: number): string =>
    tooltipLabelFormatter ? tooltipLabelFormatter("", [{ payload: { [dataKey]: v } }]) : String(v);
  let zoomFrom: string | null = null;
  let zoomTo: string | null = null;
  if (syncZoomSelection) {
    const a = Number(syncZoomSelection.start);
    const b = Number(syncZoomSelection.current);
    if (Number.isFinite(a) && Number.isFinite(b)) {
      zoomFrom = formatZoomEdge(Math.min(a, b));
      zoomTo = formatZoomEdge(Math.max(a, b));
    }
  }

  const sharedMouseHandlers = {
    className: sync?.zoomEnabled ? "cursor-crosshair select-none" : undefined,
    onMouseDown: (e: any) => {
      if (sync?.zoomEnabled && e?.activeLabel != null) sync.startZoom(e.activeLabel);
    },
    onMouseMove: (e: any) => {
      if (sync?.zoomEnabled && sync.zoomSelection && e?.activeLabel != null) {
        sync.updateZoom(e.activeLabel);
      }
      if (e?.activePayload?.length) {
        setActivePayload(e.activePayload, e.activeTooltipIndex);
        highlight.setTooltipActive(true);
        sync?.setActiveX(e.activeLabel ?? null);
      } else {
        highlight.setTooltipActive(false);
        sync?.setActiveX(null);
      }
    },
    onMouseUp: () => {
      if (sync?.zoomEnabled) sync.endZoom(bucketWidthMs);
    },
    onMouseLeave: handleMouseLeave,
  };

  // Pass the tooltip as a stable ELEMENT (not an inline function). recharts remounts a function
  // `content` on the re-renders that fire while hovering along the line (sync/highlight state
  // updates), which unmounts the portaled tooltip every bucket = flicker. An element of a
  // module-level component type reconciles in place, so the tooltip stays mounted while moving.
  const tooltipContent =
    syncZoomSelection && zoomFrom != null && zoomTo != null ? (
      <ZoomRangeTooltip from={zoomFrom} to={zoomTo} />
    ) : showLegend ? (
      () => null
    ) : overlayActive ? (
      <OverlayFilteredTooltip valueFormatter={tooltipValueFormatter} />
    ) : (
      <ChartTooltipContent valueFormatter={tooltipValueFormatter} />
    );

  const referenceOverlays = (
    <>
      {/* Synced drag-to-zoom selection — mirrored across charts in the same group. */}
      {syncZoomSelection && (
        <ReferenceArea
          x1={syncZoomSelection.start}
          x2={syncZoomSelection.current}
          isFront
          stroke="var(--color-pending)"
          strokeOpacity={0.3}
          fill="var(--color-pending)"
          fillOpacity={0.15}
          className="pointer-events-none"
        />
      )}
      {/* Synced hover indicator: drawn on the *other* charts only (the hovered one shows its
          own cursor); pointer-events-none so it never steals hover. */}
      {syncActiveX != null && !highlight.tooltipActive && (
        <ReferenceLine
          x={syncActiveX}
          stroke={SYNC_LINE_COLOR}
          strokeWidth={1}
          strokeDasharray="4 4"
          isFront
          className="pointer-events-none"
        />
      )}
      {referenceLines?.map((line) => (
        <ReferenceLine
          key={`ref-${line.y}-${line.label ?? ""}`}
          y={line.y}
          stroke={line.color ?? "#4D525B"}
          strokeDasharray="4 4"
          strokeWidth={1}
          // extendDomain (not "hidden") means recharts does NOT wrap this layer in the plot
          // clipPath, so an outside-placed label can render into the right gutter unclipped.
          ifOverflow="extendDomain"
          label={
            line.label ? (
              <ReferenceLineLabel value={line.label} placement={line.labelPlacement} />
            ) : undefined
          }
        />
      ))}
    </>
  );

  // Render stacked area chart if stacked prop is true
  if (stacked && visibleSeries.length > 1) {
    // Same variants as the line chart's tooltipContent, but the default popup keeps the stacked
    // view's line-style indicator (warning overlay never applies to stacked areas).
    const stackedTooltipContent =
      syncZoomSelection && zoomFrom != null && zoomTo != null ? (
        <ZoomRangeTooltip from={zoomFrom} to={zoomTo} />
      ) : showLegend ? (
        () => null
      ) : (
        <StackedAreaTooltip valueFormatter={tooltipValueFormatter} />
      );
    return (
      <AreaChart
        data={data}
        width={width}
        height={height}
        stackOffset="none"
        margin={chartMargin}
        {...sharedMouseHandlers}
      >
        <CartesianGrid vertical={false} stroke="var(--color-grid-bright)" strokeDasharray="3 3" />
        <XAxis {...xAxisConfig} />
        <YAxis {...yAxisConfig} />
        {/* When legend is shown below, render tooltip with cursor only (no content popup) */}
        <ChartTooltip
          cursor={{ stroke: SYNC_LINE_COLOR, strokeWidth: 1 }}
          content={stackedTooltipContent}
          labelFormatter={tooltipLabelFormatter}
          isAnimationActive={false}
          allowEscapeViewBox={{ x: true, y: true }}
          wrapperStyle={{ zIndex: 1000 }}
        />
        {/* Note: Legend is now rendered by ChartRoot outside the chart container */}
        {referenceOverlays}
        {visibleSeries.map((key) => (
          <Area
            key={key}
            type={lineType}
            dataKey={key}
            stroke={config[key]?.color}
            fill={config[key]?.color}
            fillOpacity={0.6}
            strokeWidth={1}
            stackId="stack"
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    );
  }

  return (
    <LineChart
      accessibilityLayer
      data={chartData}
      width={width}
      height={height}
      margin={chartMargin}
      {...sharedMouseHandlers}
    >
      {thresholdActive ? (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset={thresholdOffset} stopColor={thresholdStroke!.aboveColor} />
            <stop
              offset={thresholdOffset}
              stopColor={config[thresholdStroke!.series ?? visibleSeries[0]]?.color}
            />
          </linearGradient>
        </defs>
      ) : null}
      <CartesianGrid vertical={false} stroke="var(--color-grid-bright)" strokeDasharray="3 3" />
      <XAxis {...xAxisConfig} />
      <YAxis {...yAxisConfig} />
      {/* When legend is shown below, render tooltip with cursor only (no content popup) */}
      <ChartTooltip
        cursor={{ stroke: SYNC_LINE_COLOR, strokeWidth: 1 }}
        content={tooltipContent}
        labelFormatter={tooltipLabelFormatter}
        isAnimationActive={false}
        allowEscapeViewBox={{ x: true, y: true }}
        wrapperStyle={{ zIndex: 1000 }}
      />
      {/* Note: Legend is now rendered by ChartRoot outside the chart container */}
      {referenceOverlays}
      {visibleSeries.map((key) => {
        // The gradient stroke only applies to the threshold's target series (default: the first);
        // other series (e.g. the grey limit line) keep their own colour.
        const gradientLine =
          thresholdActive && (thresholdStroke!.series == null || thresholdStroke!.series === key);
        return (
          <Line
            key={key}
            dataKey={key}
            type={lineType}
            stroke={gradientLine ? `url(#${gradientId})` : config[key]?.color}
            strokeWidth={1}
            dot={showDots ? { r: 1.5, fill: config[key]?.color, strokeWidth: 0 } : false}
            // The hover dot matches the line colour under it: for a gradient (threshold) line it
            // flips at the split; otherwise it's the series colour. The warning overlay draws its
            // own dot on top where it's active.
            activeDot={
              gradientLine
                ? // oxlint-disable-next-line react/no-unstable-nested-components -- Recharts invokes this renderer with hover coordinates; an element would rely on cloneElement prop injection.
                  (props: ActiveDotProps) => (
                    <ThresholdActiveDot
                      {...props}
                      dataKey={key}
                      threshold={thresholdStroke!.value}
                      aboveColor={thresholdStroke!.aboveColor}
                      baseColor={config[key]?.color ?? "var(--color-tasks)"}
                    />
                  )
                : { r: 4, fill: config[key]?.color, strokeWidth: 0 }
            }
            isAnimationActive={false}
          />
        );
      })}
      {overlayActive && (
        // Drawn after the base line so the warning colour sits on top. connectNulls={false} keeps
        // the mask to over-threshold stretches; excluded from the legend and (above) the tooltip.
        // Its active dot inherits the warning colour so the hover dot is yellow over yellow.
        // Same 1px width as the base line so the warning stretch matches the other lines — it traces
        // the same points over its over-threshold buckets, so it covers the base exactly.
        <Line
          key={WARNING_OVERLAY_KEY}
          dataKey={WARNING_OVERLAY_KEY}
          type={lineType}
          stroke={warningOverlay!.color ?? "var(--color-warning)"}
          strokeWidth={1}
          dot={false}
          activeDot={{
            r: 4,
            fill: warningOverlay!.color ?? "var(--color-warning)",
            strokeWidth: 0,
          }}
          connectNulls={false}
          legendType="none"
          isAnimationActive={false}
        />
      )}
    </LineChart>
  );
}

type ActiveDotProps = {
  cx?: number;
  cy?: number;
  value?: number | Array<number>;
  payload?: Record<string, unknown>;
};

/** Hover dot for a gradient (threshold) line: filled with the colour of the line under it —
 * the warning colour at/above the threshold, the base colour below. Reads the bucket value from
 * `payload[dataKey]` (robust across recharts versions) and falls back to the `value` prop. */
function ThresholdActiveDot({
  cx,
  cy,
  value,
  payload,
  dataKey,
  threshold,
  aboveColor,
  baseColor,
}: ActiveDotProps & {
  dataKey: string;
  threshold: number;
  aboveColor: string;
  baseColor: string;
}) {
  if (cx === undefined || cy === undefined) return null;
  const fromPayload = payload?.[dataKey];
  const raw =
    typeof fromPayload === "number"
      ? fromPayload
      : Array.isArray(value)
        ? value[value.length - 1]
        : value;
  const color = typeof raw === "number" && raw > threshold ? aboveColor : baseColor;
  return <circle cx={cx} cy={cy} r={4} fill={color} />;
}
