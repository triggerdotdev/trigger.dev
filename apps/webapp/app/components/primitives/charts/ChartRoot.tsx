import React, { useMemo } from "react";
import type * as RechartsPrimitive from "recharts";
import { ChartContainer, type ChartConfig, type ChartState } from "./Chart";
import { ChartProvider, useChartContext } from "./ChartContext";
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
  enableZoom = false,
  onZoomChange,
  minHeight,
  className,
  showLegend = false,
  maxLegendItems = 5,
  children,
}: ChartRootProps) {
  return (
    <ChartProvider
      config={config}
      data={data}
      dataKey={dataKey}
      series={series}
      state={state}
      enableZoom={enableZoom}
      onZoomChange={onZoomChange}
    >
      <ChartRootInner
        minHeight={minHeight}
        className={className}
        showLegend={showLegend}
        maxLegendItems={maxLegendItems}
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
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
};

function ChartRootInner({
  minHeight,
  className,
  showLegend = false,
  maxLegendItems = 5,
  children,
}: ChartRootInnerProps) {
  const { config, zoom } = useChartContext();
  const enableZoom = zoom !== null;

  return (
    <div className={cn("relative flex w-full flex-col", className)}>
      <div
        className={cn("h-full w-full", enableZoom && "mt-8 cursor-crosshair")}
        style={{ touchAction: "none", userSelect: "none" }}
      >
        <ChartContainer
          config={config}
          className={cn(
            "h-full w-full",
            enableZoom &&
              "[&_.recharts-surface]:cursor-crosshair [&_.recharts-wrapper]:cursor-crosshair"
          )}
          style={minHeight ? { minHeight } : undefined}
        >
          {children}
        </ChartContainer>
      </div>
      {/* Legend rendered outside the chart container */}
      {showLegend && <ChartLegendCompound maxItems={maxLegendItems} />}
    </div>
  );
}

/**
 * Hook to check if all data in the visible range is empty (zero or null).
 * Useful for rendering "no data" states.
 */
export function useHasNoData(): boolean {
  const { data, dataKey, dataKeys } = useChartContext();

  return useMemo(() => {
    if (data.length === 0) return true;

    return data.every((item) => {
      return dataKeys.every((key) => {
        const value = item[key];
        return value === 0 || value === null || value === undefined;
      });
    });
  }, [data, dataKeys]);
}

/**
 * Hook to calculate totals for each series across all data points.
 * Useful for legend displays.
 */
export function useSeriesTotal(): Record<string, number> {
  const { data, dataKey } = useChartContext();

  return useMemo(() => {
    return data.reduce((acc, item) => {
      Object.entries(item).forEach(([key, value]) => {
        if (key !== dataKey) {
          acc[key] = (acc[key] || 0) + (Number(value) || 0);
        }
      });
      return acc;
    }, {} as Record<string, number>);
  }, [data, dataKey]);
}
