import React, { useCallback, useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
  type XAxisProps,
  type YAxisProps,
} from "recharts";
import {
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
  type ChartState,
} from "~/components/primitives/charts/Chart";
import { cn } from "~/utils/cn";
import { ChartBarLoading, ChartBarInvalid, ChartBarNoData } from "./ChartLoading";
import { useChartContext } from "./ChartContext";
import { ChartRoot, useHasNoData } from "./ChartRoot";
// Legend is now rendered by ChartRoot outside the chart container
import { ZoomTooltip, useZoomHandlers } from "./ChartZoom";
import { getBarOpacity } from "./hooks/useHighlightState";
import type { ZoomRange } from "./hooks/useZoomSelection";

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
  width,
  height,
}: ChartBarRendererProps) {
  const { config, data, dataKey, dataKeys, state, highlight, zoom, showLegend } = useChartContext();
  const hasNoData = useHasNoData();
  const zoomHandlers = useZoomHandlers();
  const enableZoom = zoom !== null;

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

  // Handle mouse leave to also reset highlight
  const handleMouseLeave = useCallback(() => {
    zoomHandlers.onMouseLeave?.();
    highlight.reset();
  }, [zoomHandlers, highlight]);

  // Render loading/error states
  if (state === "loading") {
    return <ChartBarLoading />;
  } else if (state === "noData" || hasNoData) {
    return <ChartBarNoData />;
  } else if (state === "invalid") {
    return <ChartBarInvalid />;
  }

  // Get the x-axis ticks based on tooltip state
  // Only hide middle ticks when zoom is enabled (to make room for zoom instructions)
  const xAxisTicks =
    enableZoom && highlight.tooltipActive && data.length > 2
      ? [data[0]?.[dataKey], data[data.length - 1]?.[dataKey]]
      : undefined;

  return (
    <BarChart
      data={data}
      width={width}
      height={height}
      barCategoryGap={1}
      onMouseDown={zoomHandlers.onMouseDown}
      onMouseMove={(e: any) => {
        zoomHandlers.onMouseMove?.(e);
        // Update active payload for legend
        if (e?.activePayload?.length) {
          highlight.setActivePayload(e.activePayload);
          highlight.setTooltipActive(true);
        } else {
          highlight.setTooltipActive(false);
        }
      }}
      onMouseUp={zoomHandlers.onMouseUp}
      onClick={zoomHandlers.onClick}
      onMouseLeave={handleMouseLeave}
    >
      <CartesianGrid vertical={false} stroke="#272A2E" />
      <XAxis
        dataKey={dataKey}
        tickLine={false}
        tickMargin={10}
        axisLine={false}
        ticks={xAxisTicks}
        interval="preserveStartEnd"
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
        tick={{
          fill: "#878C99",
          fontSize: 11,
          style: { fontVariantNumeric: "tabular-nums" },
        }}
        domain={["auto", (dataMax: number) => dataMax * 1.15]}
        {...yAxisPropsProp}
      />
      {/* Hide tooltip when legend is shown - legend displays hover data instead */}
      {!showLegend && (
        <ChartTooltip
          cursor={{ fill: "#2C3034" }}
          content={
            tooltipLabelFormatter ? (
              <ChartTooltipContent />
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
        />
      )}

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

      {dataKeys.map((key, index, array) => {
        return (
          <Bar
            key={key}
            dataKey={key}
            stackId={stackId}
            fill={config[key]?.color}
            radius={
              [
                index === array.length - 1 ? 2 : 0,
                index === array.length - 1 ? 2 : 0,
                index === 0 ? 2 : 0,
                index === 0 ? 2 : 0,
              ] as [number, number, number, number]
            }
            activeBar={false}
            fillOpacity={1}
            onClick={(data, index, e) => handleBarClick(data, e)}
            onMouseEnter={(entry, index) => {
              if (entry.tooltipPayload?.[0]) {
                const { dataKey: hoveredKey } = entry.tooltipPayload[0];
                highlight.setHoveredBar(hoveredKey, index);
              }
            }}
            onMouseLeave={highlight.reset}
            isAnimationActive={false}
          >
            {data.map((_, dataIndex) => {
              // Don't dim bars during zoom selection
              const opacity = zoom?.isSelecting ? 1 : getBarOpacity(key, dataIndex, highlight);

              return (
                <Cell
                  key={`cell-${key}-${dataIndex}`}
                  fill={config[key]?.color}
                  fillOpacity={opacity}
                />
              );
            })}
          </Bar>
        );
      })}

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
