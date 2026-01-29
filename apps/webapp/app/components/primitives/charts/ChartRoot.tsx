import React, { useMemo } from "react";
import type * as RechartsPrimitive from "recharts";
import { ChartContainer, type ChartConfig, type ChartState } from "./Chart";
import { ChartProvider, useChartContext, type LabelFormatter } from "./ChartContext";
import { ChartLegendCompound } from "./ChartLegendCompound";
import type { ZoomRange } from "./hooks/useZoomSelection";
import { cn } from "~/utils/cn";

export type ChartRootProps = {
  config: ChartConfig;
  data: any[];
  dataKey: string;
  /** Series keys to render (if not provided, derived from config keys) */
  series?: string[];
  state?: ChartState;
  /** Function to format the x-axis label (used in legend, tooltips, etc.) */
  labelFormatter?: LabelFormatter;
  /** Enable zoom functionality */
  enableZoom?: boolean;
  /** Callback when zoom range changes */
  onZoomChange?: (range: ZoomRange) => void;
  /** Minimum height for the chart */
  minHeight?: string;
  /** Additional className for the container */
  className?: string;
  /** Show the compound legend below the chart */
  showLegend?: boolean;
  /** Maximum items in the legend before showing "view more" */
  maxLegendItems?: number;
  /** Label for the total row in the legend */
  legendTotalLabel?: string;
  /** Callback when "View all" legend button is clicked */
  onViewAllLegendItems?: () => void;
  /** When true, constrains legend to max 50% height with scrolling */
  legendScrollable?: boolean;
  /** When true, chart fills its parent container height and distributes space between chart and legend */
  fillContainer?: boolean;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
};

/**
 * Root component for the chart compound component system.
 * Provides shared context for all child chart components.
 *
 * @example Simple bar chart
 * ```tsx
 * <Chart.Root config={config} data={data} dataKey="day">
 *   <Chart.Bar stackId="a" />
 *   <Chart.Legend />
 * </Chart.Root>
 * ```
 *
 * @example Chart with zoom
 * ```tsx
 * <Chart.Root config={config} data={data} dataKey="day" enableZoom onZoomChange={handleZoom}>
 *   <Chart.Bar stackId="a" />
 *   <Chart.Zoom />
 *   <Chart.Legend />
 * </Chart.Root>
 * ```
 */
export function ChartRoot({
  config,
  data,
  dataKey,
  series,
  state,
  labelFormatter,
  enableZoom = false,
  onZoomChange,
  minHeight,
  className,
  showLegend = false,
  maxLegendItems = 5,
  legendTotalLabel,
  onViewAllLegendItems,
  legendScrollable = false,
  fillContainer = false,
  children,
}: ChartRootProps) {
  return (
    <ChartProvider
      config={config}
      data={data}
      dataKey={dataKey}
      series={series}
      state={state}
      labelFormatter={labelFormatter}
      enableZoom={enableZoom}
      onZoomChange={onZoomChange}
      showLegend={showLegend}
    >
      <ChartRootInner
        minHeight={minHeight}
        className={className}
        showLegend={showLegend}
        maxLegendItems={maxLegendItems}
        legendTotalLabel={legendTotalLabel}
        onViewAllLegendItems={onViewAllLegendItems}
        legendScrollable={legendScrollable}
        fillContainer={fillContainer}
      >
        {children}
      </ChartRootInner>
    </ChartProvider>
  );
}

type ChartRootInnerProps = {
  minHeight?: string;
  className?: string;
  showLegend?: boolean;
  maxLegendItems?: number;
  legendTotalLabel?: string;
  onViewAllLegendItems?: () => void;
  legendScrollable?: boolean;
  fillContainer?: boolean;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
};

function ChartRootInner({
  minHeight,
  className,
  showLegend = false,
  maxLegendItems = 5,
  legendTotalLabel,
  onViewAllLegendItems,
  legendScrollable = false,
  fillContainer = false,
  children,
}: ChartRootInnerProps) {
  const { config, zoom } = useChartContext();
  const enableZoom = zoom !== null;

  return (
    <div
      className={cn(
        "relative flex w-full flex-col",
        fillContainer && "h-full",
        className
      )}
    >
      <div
        className={cn(
          fillContainer ? "min-h-0 flex-1" : "h-full w-full",
          enableZoom && "mt-8 cursor-crosshair"
        )}
        style={{ touchAction: "none", userSelect: "none" }}
      >
        <ChartContainer
          config={config}
          className={cn(
            "h-full w-full",
            fillContainer && "!aspect-auto",
            enableZoom &&
            "[&_.recharts-surface]:cursor-crosshair [&_.recharts-wrapper]:cursor-crosshair"
          )}
          style={fillContainer ? undefined : minHeight ? { minHeight } : undefined}
        >
          {children}
        </ChartContainer>
      </div>
      {/* Legend rendered outside the chart container */}
      {showLegend && (
        <ChartLegendCompound
          maxItems={maxLegendItems}
          totalLabel={legendTotalLabel}
          onViewAllLegendItems={onViewAllLegendItems}
          scrollable={legendScrollable}
        />
      )}
    </div>
  );
}

/**
 * Hook to check if all data in the visible range is empty (null or undefined).
 * Zero values are considered valid data and will render.
 * Useful for rendering "no data" states.
 */
export function useHasNoData(): boolean {
  const { data, dataKey, dataKeys } = useChartContext();

  return useMemo(() => {
    if (data.length === 0) return true;

    return data.every((item) => {
      return dataKeys.every((key) => {
        const value = item[key];
        return value === null || value === undefined;
      });
    });
  }, [data, dataKeys]);
}

/**
 * Hook to calculate totals for each series across all data points.
 * Useful for legend displays.
 */
export function useSeriesTotal(): Record<string, number> {
  const { data, dataKeys } = useChartContext();

  return useMemo(() => {
    return data.reduce((acc, item) => {
      for (const seriesKey of dataKeys) {
        acc[seriesKey] = (acc[seriesKey] || 0) + Number(item[seriesKey] || 0);
      }
      return acc;
    }, {} as Record<string, number>);
  }, [data, dataKeys]);
}
