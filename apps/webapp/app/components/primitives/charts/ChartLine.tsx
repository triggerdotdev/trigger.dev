import React, { useCallback, useMemo } from "react";
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
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartState,
} from "~/components/primitives/charts/Chart";
import { cn } from "~/utils/cn";
import { ChartLineLoading, ChartLineNoData, ChartLineInvalid } from "./ChartLoading";
import { useDateRange } from "./DateRangeContext";

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

type ChartLineProps = {
  config: ChartConfig;
  data: any[];
  dataKey: string;
  state?: ChartState;
  useGlobalDateRange?: boolean;
  lineType?: CurveType;
  /** Series keys to render (if not provided, derived from config keys) */
  series?: string[];
  /** Custom X-axis props to merge with defaults */
  xAxisProps?: Partial<XAxisProps>;
  /** Custom Y-axis props to merge with defaults */
  yAxisProps?: Partial<YAxisProps>;
  /** Render as stacked area chart instead of line chart */
  stacked?: boolean;
  /** Custom tooltip label formatter */
  tooltipLabelFormatter?: (label: string, payload: any[]) => string;
  /** Show legend (default false) */
  showLegend?: boolean;
  /** Additional className for the container */
  className?: string;
  /** Minimum height for the chart */
  minHeight?: string;
};

export function ChartLine({
  config,
  data: initialData,
  dataKey,
  state,
  useGlobalDateRange = false,
  lineType = "step",
  series: seriesProp,
  xAxisProps: xAxisPropsProp,
  yAxisProps: yAxisPropsProp,
  stacked = false,
  tooltipLabelFormatter,
  showLegend = false,
  className,
  minHeight,
}: ChartLineProps) {
  const globalDateRange = useDateRange();
  const [tooltipActive, setTooltipActive] = React.useState(false);

  // Display state for chart rendering
  const displayState = state;

  // Compute the visible data based on the date range
  const data = useMemo(() => {
    if (useGlobalDateRange) {
      // Filter data based on global date range
      // Check if we have valid chart data
      if (initialData.length === 0) return [];

      // Get a sorted list of all available day values
      const allDays = initialData
        .map((item) => item[dataKey] as string)
        .filter(Boolean)
        .sort();

      // Check if our date range is in the available dates
      const startDateIndex = allDays.findIndex((day) => day === globalDateRange?.startDate);
      const endDateIndex = allDays.findIndex((day) => day === globalDateRange?.endDate);

      // If we can't find the exact dates, just return all data
      if (startDateIndex === -1 || endDateIndex === -1) {
        return initialData;
      }

      // Filter to only include items within the range
      return initialData.filter((item) => {
        const itemDate = item[dataKey] as string;
        const itemIndex = allDays.indexOf(itemDate);
        // Include if the day is within the range (inclusive)
        return itemIndex >= startDateIndex && itemIndex <= endDateIndex;
      });
    }
    return initialData;
  }, [
    initialData,
    useGlobalDateRange,
    globalDateRange?.startDate,
    globalDateRange?.endDate,
    dataKey,
  ]);

  // Get all data keys except the x-axis key (use series prop if provided)
  const dataKeys = useMemo(
    () => seriesProp ?? Object.keys(config).filter((k) => k !== dataKey),
    [seriesProp, config, dataKey]
  );

  // Check if data has no values (all zero or null)
  const hasNoData = useMemo(() => {
    if (data.length === 0) return true;

    // Check if all data points have zero or null values for all dataKeys
    return data.every((item) => {
      return dataKeys.every((key) => {
        const value = item[key];
        return value === 0 || value === null || value === undefined;
      });
    });
  }, [data, dataKeys]);

  // Render appropriate content based on displayState
  const renderChartContent = useCallback(() => {
    if (displayState === "loading") {
      return <ChartLineLoading />;
    } else if (displayState === "noData" || hasNoData) {
      return <ChartLineNoData />;
    } else if (displayState === "invalid") {
      return <ChartLineInvalid />;
    }

    // Get the x-axis ticks based on tooltip state
    const xAxisTicks =
      tooltipActive && data.length > 2
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

    // Render stacked area chart if stacked prop is true
    if (stacked && dataKeys.length > 1) {
      return (
        <AreaChart
          data={data}
          stackOffset="none"
          margin={{
            left: 12,
            right: 12,
          }}
          onMouseEnter={() => setTooltipActive(true)}
          onMouseLeave={() => setTooltipActive(false)}
        >
          <CartesianGrid vertical={false} stroke="#272A2E" strokeDasharray="3 3" />
          <XAxis {...xAxisConfig} />
          <YAxis {...yAxisConfig} />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent indicator="line" />}
            labelFormatter={tooltipLabelFormatter}
          />
          {showLegend && <ChartLegend content={<ChartLegendContent />} />}
          {dataKeys.map((key) => (
            <Area
              key={key}
              type={lineType}
              dataKey={key}
              stroke={config[key]?.color}
              fill={config[key]?.color}
              fillOpacity={0.6}
              strokeWidth={2}
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
        margin={{
          left: 12,
          right: 12,
        }}
        onMouseEnter={() => setTooltipActive(true)}
        onMouseLeave={() => setTooltipActive(false)}
      >
        <CartesianGrid vertical={false} stroke="#272A2E" strokeDasharray="3 3" />
        <XAxis {...xAxisConfig} />
        <YAxis {...yAxisConfig} />
        <ChartTooltip
          cursor={false}
          content={<ChartTooltipContent />}
          labelFormatter={tooltipLabelFormatter}
        />
        {showLegend && <ChartLegend content={<ChartLegendContent />} />}
        {dataKeys.map((key) => (
          <Line
            key={key}
            dataKey={key}
            type={lineType}
            stroke={config[key]?.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    );
  }, [
    displayState,
    hasNoData,
    tooltipActive,
    data,
    dataKey,
    dataKeys,
    config,
    lineType,
    stacked,
    xAxisPropsProp,
    yAxisPropsProp,
    tooltipLabelFormatter,
    showLegend,
  ]);

  return (
    <div className={cn("relative flex w-full flex-col", className)}>
      <div className="h-full w-full" style={{ touchAction: "none", userSelect: "none" }}>
        <ChartContainer
          config={config}
          className="min-h-[200px] w-full"
          style={minHeight ? { minHeight } : undefined}
        >
          {renderChartContent()}
        </ChartContainer>
      </div>
    </div>
  );
}
