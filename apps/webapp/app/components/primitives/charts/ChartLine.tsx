import React from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
  type XAxisProps,
  type YAxisProps,
} from "recharts";
import {
  type ChartConfig,
  ChartTooltip,
  ChartTooltipContent,
  type ChartState,
} from "~/components/primitives/charts/Chart";
import { ChartLineLoading, ChartLineNoData, ChartLineInvalid } from "./ChartLoading";
import { useChartContext } from "./ChartContext";
import { ChartRoot, useHasNoData } from "./ChartRoot";
// Legend is now rendered by ChartRoot outside the chart container
import type { ZoomRange } from "./hooks/useZoomSelection";

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
  /** Width injected by ResponsiveContainer */
  width?: number;
  /** Height injected by ResponsiveContainer */
  height?: number;
};

/**
 * Line chart renderer for the compound component system.
 * Must be used within a Chart.Root.
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
  width,
  height,
}: ChartLineRendererProps) {
  const { config, data, dataKey, dataKeys, state, highlight, showLegend } = useChartContext();
  const hasNoData = useHasNoData();

  // Render loading/error states
  if (state === "loading") {
    return <ChartLineLoading />;
  } else if (state === "noData" || hasNoData) {
    return <ChartLineNoData />;
  } else if (state === "invalid") {
    return <ChartLineInvalid />;
  }

  // Get the x-axis ticks based on tooltip state
  const xAxisTicks =
    highlight.tooltipActive && data.length > 2
      ? [data[0]?.[dataKey], data[data.length - 1]?.[dataKey]]
      : undefined;

  const xAxisConfig = {
    dataKey,
    tickLine: false,
    axisLine: false,
    tickMargin: 10,
    ticks: xAxisTicks,
    interval: "preserveStartEnd" as const,
    tick: {
      fill: "#878C99",
      fontSize: 11,
      style: { fontVariantNumeric: "tabular-nums" },
    },
    ...xAxisPropsProp,
  };

  const yAxisConfig = {
    axisLine: false,
    tickLine: false,
    tickMargin: 8,
    tick: {
      fill: "#878C99",
      fontSize: 11,
      style: { fontVariantNumeric: "tabular-nums" },
    },
    ...yAxisPropsProp,
  };

  // Handle mouse leave to also reset highlight
  const handleMouseLeave = () => {
    highlight.setTooltipActive(false);
    highlight.reset();
  };

  // Render stacked area chart if stacked prop is true
  if (stacked && dataKeys.length > 1) {
    return (
      <AreaChart
        data={data}
        width={width}
        height={height}
        stackOffset="none"
        margin={{
          left: 12,
          right: 12,
        }}
        onMouseMove={(e: any) => {
          // Update active payload for legend
          if (e?.activePayload?.length) {
            highlight.setActivePayload(e.activePayload);
            highlight.setTooltipActive(true);
          } else {
            highlight.setTooltipActive(false);
          }
        }}
        onMouseLeave={handleMouseLeave}
      >
        <CartesianGrid vertical={false} stroke="#272A2E" strokeDasharray="3 3" />
        <XAxis {...xAxisConfig} />
        <YAxis {...yAxisConfig} />
        {/* Hide tooltip when legend is shown - legend displays hover data instead */}
        {!showLegend && (
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent indicator="line" />}
            labelFormatter={tooltipLabelFormatter}
          />
        )}
        {/* Note: Legend is now rendered by ChartRoot outside the chart container */}
        {dataKeys.map((key) => (
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
      data={data}
      width={width}
      height={height}
      margin={{
        left: 12,
        right: 12,
      }}
      onMouseMove={(e: any) => {
        // Update active payload for legend
        if (e?.activePayload?.length) {
          highlight.setActivePayload(e.activePayload);
          highlight.setTooltipActive(true);
        } else {
          highlight.setTooltipActive(false);
        }
      }}
      onMouseLeave={handleMouseLeave}
    >
      <CartesianGrid vertical={false} stroke="#272A2E" strokeDasharray="3 3" />
      <XAxis {...xAxisConfig} />
      <YAxis {...yAxisConfig} />
      {/* Hide tooltip when legend is shown - legend displays hover data instead */}
      {!showLegend && (
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent />}
          labelFormatter={tooltipLabelFormatter}
        />
      )}
      {/* Note: Legend is now rendered by ChartRoot outside the chart container */}
      {dataKeys.map((key) => (
        <Line
          key={key}
          dataKey={key}
          type={lineType}
          stroke={config[key]?.color}
          strokeWidth={1}
          dot={false}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
      ))}
    </LineChart>
  );
}
