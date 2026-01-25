/**
 * Compound Chart Component System
 *
 * This module exports a unified Chart compound component that can render
 * different chart types (bar, line, etc.) with optional features like
 * zoom and legends.
 *
 * Note: Due to recharts' component hierarchy requirements, the Legend must be
 * rendered inside the chart component (BarChart, LineChart). Use the showLegend
 * prop on Chart.Bar or Chart.Line instead of Chart.Legend as a sibling.
 *
 * @example Simple bar chart with legend
 * ```tsx
 * import { Chart } from "~/components/primitives/charts/ChartCompound";
 *
 * <Chart.Root config={config} data={data} dataKey="day">
 *   <Chart.Bar stackId="a" showLegend maxLegendItems={5} />
 * </Chart.Root>
 * ```
 *
 * @example Line chart
 * ```tsx
 * <Chart.Root config={config} data={data} dataKey="day">
 *   <Chart.Line lineType="step" showLegend />
 * </Chart.Root>
 * ```
 *
 * @example Bar chart with zoom (callback-based)
 * ```tsx
 * function MyChart() {
 *   const handleZoomChange = (range: ZoomRange) => {
 *     // Fetch new data based on range, update state
 *   };
 *
 *   return (
 *     <Chart.Root
 *       config={config}
 *       data={data}
 *       dataKey="day"
 *       enableZoom
 *       onZoomChange={handleZoomChange}
 *     >
 *       <Chart.Bar stackId="a" showLegend />
 *     </Chart.Root>
 *   );
 * }
 * ```
 *
 * @example Dashboard with synced charts (using DateRangeContext)
 * ```tsx
 * <DateRangeProvider defaultStartDate={start} defaultEndDate={end}>
 *   <DashboardControls />
 *
 *   <Chart.Root config={config1} data={data1} dataKey="day" enableZoom onZoomChange={handleZoom1}>
 *     <Chart.Bar showLegend />
 *   </Chart.Root>
 *
 *   <Chart.Root config={config2} data={data2} dataKey="day" enableZoom onZoomChange={handleZoom2}>
 *     <Chart.Line showLegend />
 *   </Chart.Root>
 * </DateRangeProvider>
 * ```
 */

import { ChartRoot } from "./ChartRoot";
import { ChartBarRenderer } from "./ChartBar";
import { ChartLineRenderer } from "./ChartLine";
import { ChartLegendCompound } from "./ChartLegendCompound";
import { ChartZoom } from "./ChartZoom";

// Re-export types
export type { ChartConfig, ChartState } from "./Chart";
export type { ZoomRange } from "./hooks/useZoomSelection";
export type { ChartRootProps } from "./ChartRoot";
export type { ChartBarRendererProps } from "./ChartBar";
export type { ChartLineRendererProps } from "./ChartLine";
export type { ChartLegendCompoundProps } from "./ChartLegendCompound";
export type { ChartZoomProps } from "./ChartZoom";

/**
 * Chart compound component for building flexible, composable charts.
 *
 * Components:
 * - `Chart.Root` - Main wrapper that provides context
 * - `Chart.Bar` - Bar chart renderer (use showLegend prop for legend)
 * - `Chart.Line` - Line/area chart renderer (use showLegend prop for legend)
 * - `Chart.Zoom` - Optional zoom overlay (rendered internally when enableZoom is set)
 *
 * Note: Chart.Legend is exported for advanced use cases but should typically
 * be enabled via the showLegend prop on Chart.Bar or Chart.Line.
 */
export const Chart = {
  Root: ChartRoot,
  Bar: ChartBarRenderer,
  Line: ChartLineRenderer,
  Legend: ChartLegendCompound,
  Zoom: ChartZoom,
};

// Also export individual components for direct imports
export { ChartRoot, ChartBarRenderer, ChartLineRenderer, ChartLegendCompound, ChartZoom };

// Re-export context hook for advanced usage
export { useChartContext } from "./ChartContext";
export { useHasNoData, useSeriesTotal } from "./ChartRoot";
export { useZoomHandlers, ZoomTooltip } from "./ChartZoom";
