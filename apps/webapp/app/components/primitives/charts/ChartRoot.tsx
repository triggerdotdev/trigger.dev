import React, { useMemo } from "react";
import type * as RechartsPrimitive from "recharts";
import type { AggregationType } from "~/components/metrics/QueryWidget";
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
  /** Subset of series to render as SVG elements on the chart (legend still shows all series) */
  visibleSeries?: string[];
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
  /** Aggregation method used by the legend to compute totals (defaults to sum behavior) */
  legendAggregation?: AggregationType;
  /** Callback when "View all" legend button is clicked */
  onViewAllLegendItems?: () => void;
  /** When true, constrains legend to max 50% height with scrolling */
  legendScrollable?: boolean;
  /** When true, chart fills its parent container height and distributes space between chart and legend */
  fillContainer?: boolean;
  /** Content rendered between the chart and the legend */
  beforeLegend?: React.ReactNode;
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
  visibleSeries,
  state,
  labelFormatter,
  enableZoom = false,
  onZoomChange,
  minHeight,
  className,
  showLegend = false,
  maxLegendItems = 5,
  legendTotalLabel,
  legendAggregation,
  onViewAllLegendItems,
  legendScrollable = false,
  fillContainer = false,
  beforeLegend,
  children,
}: ChartRootProps) {
  return (
    <ChartProvider
      config={config}
      data={data}
      dataKey={dataKey}
      series={series}
      visibleSeries={visibleSeries}
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
        legendAggregation={legendAggregation}
        onViewAllLegendItems={onViewAllLegendItems}
        legendScrollable={legendScrollable}
        fillContainer={fillContainer}
        beforeLegend={beforeLegend}
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
  legendAggregation?: AggregationType;
  onViewAllLegendItems?: () => void;
  legendScrollable?: boolean;
  fillContainer?: boolean;
  beforeLegend?: React.ReactNode;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
};

function ChartRootInner({
  minHeight,
  className,
  showLegend = false,
  maxLegendItems = 5,
  legendTotalLabel,
  legendAggregation,
  onViewAllLegendItems,
  legendScrollable = false,
  fillContainer = false,
  beforeLegend,
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
      {beforeLegend}
      {/* Legend rendered outside the chart container */}
      {showLegend && (
        <ChartLegendCompound
          maxItems={maxLegendItems}
          totalLabel={legendTotalLabel}
          aggregation={legendAggregation}
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
 * Hook to calculate aggregated values for each series across all data points.
 * When no aggregation is provided, defaults to sum (original behavior).
 * Useful for legend displays.
 */
export function useSeriesTotal(aggregation?: AggregationType): Record<string, number> {
  const { data, dataKeys } = useChartContext();

  return useMemo(() => {
    // Sum (default) and count use additive accumulation
    if (!aggregation || aggregation === "sum" || aggregation === "count") {
      return data.reduce(
        (acc, item) => {
          for (const seriesKey of dataKeys) {
            acc[seriesKey] = (acc[seriesKey] || 0) + Number(item[seriesKey] || 0);
          }
          return acc;
        },
        {} as Record<string, number>
      );
    }

    if (aggregation === "avg") {
      const sums: Record<string, number> = {};
      const counts: Record<string, number> = {};
      for (const item of data) {
        for (const seriesKey of dataKeys) {
          const rawVal = item[seriesKey];
          if (rawVal == null) continue; // skip gap-filled nulls
          const val = Number(rawVal);
          sums[seriesKey] = (sums[seriesKey] || 0) + val;
          counts[seriesKey] = (counts[seriesKey] || 0) + 1;
        }
      }
      const result: Record<string, number> = {};
      for (const key of dataKeys) {
        result[key] = counts[key] ? sums[key]! / counts[key]! : 0;
      }
      return result;
    }

    if (aggregation === "min") {
      const result: Record<string, number> = {};
      for (const item of data) {
        for (const seriesKey of dataKeys) {
          if (item[seriesKey] == null) continue; // skip gap-filled nulls
          const val = Number(item[seriesKey]);
          if (result[seriesKey] === undefined || val < result[seriesKey]) {
            result[seriesKey] = val;
          }
        }
      }
      // Default to 0 for series with no data
      for (const key of dataKeys) {
        if (result[key] === undefined) result[key] = 0;
      }
      return result;
    }

    // aggregation === "max"
    const result: Record<string, number> = {};
    for (const item of data) {
      for (const seriesKey of dataKeys) {
        if (item[seriesKey] == null) continue; // skip gap-filled nulls
        const val = Number(item[seriesKey]);
        if (result[seriesKey] === undefined || val > result[seriesKey]) {
          result[seriesKey] = val;
        }
      }
    }
    // Default to 0 for series with no data
    for (const key of dataKeys) {
      if (result[key] === undefined) result[key] = 0;
    }
    return result;
  }, [data, dataKeys, aggregation]);
}
