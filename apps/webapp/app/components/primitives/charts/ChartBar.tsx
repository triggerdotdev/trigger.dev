import React, { useCallback } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
  type XAxisProps,
  type YAxisProps,
} from "recharts";
import { ChartTooltip, ChartTooltipContent } from "~/components/primitives/charts/Chart";
import TooltipPortal from "~/components/primitives/TooltipPortal";
import { useChartContext } from "./ChartContext";
import { ChartBarInvalid, ChartBarLoading, ChartBarNoData } from "./ChartLoading";
import { useHasNoData } from "./ChartRoot";
import { defaultYAxisTickFormatter, useYAxisWidth } from "./useYAxisWidth";
import { useXAxisTicks } from "./useXAxisTicks";
import { useChartSync } from "./ChartSyncContext";
import { ZoomTooltip, useZoomHandlers } from "./ChartZoom";

// charcoal-500: dashed line mirroring the hovered x across synced charts.
const SYNC_LINE_COLOR = "#5F6570";

// Shared with ChartLine so bar/line align when toggling. Right margin keeps the
// centered last x-axis label from clipping; bottom gives angled labels room.
export const CHART_MARGIN = { top: 5, right: 20, bottom: 5, left: 5 } as const;

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

//TODO: fix the first and last bars in a stack not having rounded corners

type ReferenceLineProps = {
  value: number;
  label: string;
};

// ============================================================================
// COMPOUND COMPONENT API
// ============================================================================

export type ChartBarRendererProps = {
  /** Stack ID for stacked bar charts */
  stackId?: string;
  /** Custom X-axis props to merge with defaults */
  xAxisProps?: Partial<XAxisProps>;
  /** Custom Y-axis props to merge with defaults */
  yAxisProps?: Partial<YAxisProps>;
  /** Reference line (horizontal) */
  referenceLine?: ReferenceLineProps;
  /** Custom tooltip label formatter */
  tooltipLabelFormatter?: (label: string, payload: any[]) => string;
  /** Optional formatter for numeric tooltip values (e.g. bytes, duration) */
  tooltipValueFormatter?: (value: number) => string;
  /** Corner radius for the outermost bars in each stack (defaults to 2). Pass 0 for square corners. */
  barRadius?: number;
  /** Width injected by ResponsiveContainer */
  width?: number;
  /** Height injected by ResponsiveContainer */
  height?: number;
};

/**
 * Bar chart renderer for the compound component system.
 * Must be used within a Chart.Root.
 *
 * @example
 * ```tsx
 * <Chart.Root config={config} data={data} dataKey="day">
 *   <Chart.Bar stackId="a" />
 *   <Chart.Legend />
 * </Chart.Root>
 * ```
 */
export function ChartBarRenderer({
  stackId,
  xAxisProps: xAxisPropsProp,
  yAxisProps: yAxisPropsProp,
  referenceLine,
  tooltipLabelFormatter,
  tooltipValueFormatter,
  barRadius = 2,
  width,
  height,
}: ChartBarRendererProps) {
  const {
    config,
    data,
    dataKey,
    dataKeys: _dataKeys,
    visibleSeries,
    state,
    highlight,
    setActivePayload,
    zoom,
    showLegend,
  } = useChartContext();
  const hasNoData = useHasNoData();
  const zoomHandlers = useZoomHandlers();
  const sync = useChartSync();
  const enableZoom = zoom !== null;
  const yAxisTickFormatter = yAxisPropsProp?.tickFormatter ?? defaultYAxisTickFormatter;
  const computedYAxisWidth = useYAxisWidth(data, visibleSeries, yAxisTickFormatter);

  // Width-aware horizontal labels, but only when the caller isn't already
  // controlling ticks/interval/angle (e.g. the query widget's angled axes).
  const callerControlsXTicks =
    xAxisPropsProp?.ticks !== undefined ||
    xAxisPropsProp?.interval !== undefined ||
    xAxisPropsProp?.angle !== undefined;
  // Plot width = full width minus the y-axis and horizontal margins.
  const xAxisPlotWidth =
    width != null
      ? Math.max(0, width - computedYAxisWidth - CHART_MARGIN.left - CHART_MARGIN.right)
      : undefined;
  const autoXTicks = useXAxisTicks(
    data,
    dataKey,
    xAxisPlotWidth,
    xAxisPropsProp?.tickFormatter as ((value: any, index: number) => string) | undefined
  );

  const handleBarClick = useCallback(
    (barData: any, e: React.MouseEvent) => {
      if (!enableZoom || !zoom) return;
      e.stopPropagation();

      if (!zoom.isSelecting) {
        zoom.toggleInspectionLine(barData[dataKey]);
      }
    },
    [enableZoom, zoom, dataKey]
  );

  // Reset highlight and cancel any in-progress zoom drag on leave.
  const handleMouseLeave = useCallback(() => {
    zoomHandlers.onMouseLeave?.();
    highlight.reset();
    sync?.setActiveX(null);
    sync?.cancelZoom();
  }, [zoomHandlers, highlight, sync]);

  // Render loading/error states
  if (state === "loading") {
    return <ChartBarLoading />;
  } else if (state === "noData" || hasNoData) {
    return <ChartBarNoData />;
  } else if (state === "invalid") {
    return <ChartBarInvalid />;
  }

  // When zoom is enabled, collapse to first/last ticks during hover to make room
  // for the zoom instructions.
  const zoomXAxisTicks =
    enableZoom && highlight.tooltipActive && data.length > 2
      ? [data[0]?.[dataKey], data[data.length - 1]?.[dataKey]]
      : undefined;

  // Zoom ticks win; otherwise use width-aware auto ticks unless the caller
  // controls tick placement.
  const useAutoXTicks = !callerControlsXTicks && !zoomXAxisTicks && autoXTicks != null;
  const baseXTicks = zoomXAxisTicks ?? (useAutoXTicks ? autoXTicks : undefined);
  const baseXInterval = useAutoXTicks ? 0 : ("preserveStartEnd" as const);

  const syncActiveX = sync?.activeX ?? null;
  const syncZoomSelection = sync?.zoomSelection ?? null;
  // Bucket width so the committed zoom range includes the last selected bucket.
  const bucketWidthMs = data.length >= 2 ? Number(data[1][dataKey]) - Number(data[0][dataKey]) : 0;

  // Reuse the tooltip label formatter for the From/To edges (it reads `bucket` off the payload).
  const formatZoomEdge = (v: number): string =>
    tooltipLabelFormatter ? tooltipLabelFormatter("", [{ payload: { bucket: v } }]) : String(v);
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

  return (
    <BarChart
      data={data}
      width={width}
      height={height}
      barCategoryGap={1}
      margin={CHART_MARGIN}
      className={sync?.zoomEnabled ? "cursor-crosshair select-none" : undefined}
      onMouseDown={(e: any) => {
        zoomHandlers.onMouseDown?.(e);
        if (sync?.zoomEnabled && e?.activeLabel != null) sync.startZoom(e.activeLabel);
      }}
      onMouseMove={(e: any) => {
        zoomHandlers.onMouseMove?.(e);
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
      }}
      onMouseUp={() => {
        zoomHandlers.onMouseUp?.();
        if (sync?.zoomEnabled) sync.endZoom(bucketWidthMs);
      }}
      onClick={zoomHandlers.onClick}
      onMouseLeave={handleMouseLeave}
    >
      <CartesianGrid vertical={false} stroke="#272A2E" />
      <XAxis
        dataKey={dataKey}
        tickLine={false}
        tickMargin={10}
        axisLine={false}
        ticks={baseXTicks}
        interval={baseXInterval}
        tick={{
          fill: "#878C99",
          fontSize: 11,
          style: { fontVariantNumeric: "tabular-nums" },
        }}
        {...xAxisPropsProp}
      />
      <YAxis
        axisLine={false}
        tickLine={false}
        tickMargin={8}
        width={computedYAxisWidth}
        tick={{
          fill: "#878C99",
          fontSize: 11,
          style: { fontVariantNumeric: "tabular-nums" },
        }}
        tickFormatter={yAxisTickFormatter}
        domain={["auto", (dataMax: number) => dataMax * 1.15]}
        {...yAxisPropsProp}
      />
      {/* When legend is shown below the chart, render tooltip with cursor only (no content popup).
          Otherwise render the full tooltip with zoom instructions. */}
      <ChartTooltip
        cursor={{ fill: "rgba(255, 255, 255, 0.06)" }}
        content={
          syncZoomSelection && zoomFrom != null && zoomTo != null ? (
            <ZoomRangeTooltip from={zoomFrom} to={zoomTo} />
          ) : showLegend ? (
            () => null
          ) : tooltipLabelFormatter ? (
            <ChartTooltipContent valueFormatter={tooltipValueFormatter} />
          ) : (
            <ZoomTooltip
              isSelecting={zoom?.isSelecting}
              refAreaLeft={zoom?.refAreaLeft}
              refAreaRight={zoom?.refAreaRight}
              invalidSelection={zoom?.invalidSelection}
            />
          )
        }
        labelFormatter={tooltipLabelFormatter}
        allowEscapeViewBox={{ x: false, y: true }}
        animationDuration={0}
      />

      {/* Zoom selection area - rendered before bars to appear behind them */}
      {enableZoom && zoom?.refAreaLeft !== null && zoom?.refAreaRight !== null && (
        <ReferenceArea
          x1={zoom.refAreaLeft}
          x2={zoom.refAreaRight}
          strokeOpacity={0.4}
          fill="#3B82F6"
          fillOpacity={0.3}
        />
      )}

      {visibleSeries.map((key, index, array) => {
        const dimmed =
          !zoom?.isSelecting && highlight.activeBarKey !== null && highlight.activeBarKey !== key;

        return (
          <Bar
            key={key}
            dataKey={key}
            stackId={stackId}
            fill={config[key]?.color}
            radius={
              [
                index === array.length - 1 ? barRadius : 0,
                index === array.length - 1 ? barRadius : 0,
                index === 0 ? barRadius : 0,
                index === 0 ? barRadius : 0,
              ] as [number, number, number, number]
            }
            activeBar={false}
            fillOpacity={dimmed ? 0.2 : 1}
            onClick={(data, index, e) => handleBarClick(data, e)}
            onMouseEnter={(entry, index) => {
              if (entry.tooltipPayload?.[0]) {
                const { dataKey: hoveredKey } = entry.tooltipPayload[0];
                highlight.setHoveredBar(hoveredKey, index);
              }
            }}
            onMouseLeave={highlight.reset}
            isAnimationActive={false}
          />
        );
      })}

      {/* Synced drag-to-zoom selection — mirrored across charts in the same group. */}
      {syncZoomSelection && (
        <ReferenceArea
          x1={syncZoomSelection.start}
          x2={syncZoomSelection.current}
          isFront
          stroke="#3B82F6"
          strokeOpacity={0.3}
          fill="#3B82F6"
          fillOpacity={0.15}
          className="pointer-events-none"
        />
      )}

      {/* Synced hover indicator: drawn on the *other* charts only (the hovered one
          shows its own cursor); pointer-events-none so it never steals hover. */}
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

      {/* Horizontal reference line */}
      {referenceLine && (
        <ReferenceLine
          y={referenceLine.value}
          label={{
            position: "top",
            value: referenceLine.label,
            fill: "#878C99",
            fontSize: 11,
          }}
          isFront={true}
          stroke="#3B3E45"
          strokeDasharray="4 4"
          className="pointer-events-none"
        />
      )}

      {/* Zoom inspection line - rendered after bars to appear on top */}
      {enableZoom && zoom?.inspectionLine && (
        <ReferenceLine
          x={zoom.inspectionLine}
          stroke="#D7D9DD"
          strokeWidth={2}
          isFront={true}
          onClick={(e: any) => {
            e?.stopPropagation?.();
            zoom.clearInspectionLine();
          }}
        />
      )}

      {/* Note: Legend is now rendered by ChartRoot outside the chart container */}
    </BarChart>
  );
}
