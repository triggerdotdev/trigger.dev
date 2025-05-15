import React, { useCallback, useMemo } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartState,
} from "~/components/primitives/charts/Chart";
import { ChartLineLoading, ChartNoData, ChartInvalid } from "./ChartLoading";
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

export function ChartLine({
  config,
  data: initialData,
  dataKey,
  state,
  useGlobalDateRange = false,
  lineType = "step",
}: {
  config: ChartConfig;
  data: any[];
  dataKey: string;
  state?: ChartState;
  useGlobalDateRange?: boolean;
  lineType?: CurveType;
}) {
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
      const startDateIndex = allDays.findIndex((day) => day === globalDateRange.startDate);
      const endDateIndex = allDays.findIndex((day) => day === globalDateRange.endDate);

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
    globalDateRange.startDate,
    globalDateRange.endDate,
    dataKey,
  ]);

  // Check if data has no values (all zero or null)
  const hasNoData = useMemo(() => {
    if (data.length === 0) return true;

    // Get all data keys except the x-axis key
    const valueKeys = Object.keys(config).filter((k) => k !== dataKey);

    // Check if all data points have zero or null values for all valueKeys
    return data.every((item) => {
      return valueKeys.every((key) => {
        const value = item[key];
        return value === 0 || value === null || value === undefined;
      });
    });
  }, [data, config, dataKey]);

  // Render appropriate content based on displayState
  const renderChartContent = useCallback(() => {
    if (displayState === "loading") {
      return <ChartLineLoading />;
    } else if (displayState === "noData" || hasNoData) {
      return <ChartNoData />;
    } else if (displayState === "invalid") {
      return <ChartInvalid />;
    }

    // Get the x-axis ticks based on tooltip state
    const xAxisTicks =
      tooltipActive && data.length > 2
        ? [data[0]?.[dataKey], data[data.length - 1]?.[dataKey]]
        : undefined;

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
        <CartesianGrid vertical={false} stroke="#272A2E" />
        <XAxis
          dataKey={dataKey}
          tickLine={false}
          axisLine={false}
          tickMargin={10}
          ticks={xAxisTicks}
          interval="preserveStartEnd"
          tick={{
            fill: "#878C99",
            fontSize: 11,
            style: { fontVariantNumeric: "tabular-nums" },
          }}
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
          domain={[0, 100]}
          tickFormatter={(value) => `${value}%`}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
        {Object.keys(config).map((key) => (
          <Line
            key={key}
            dataKey={key}
            type={lineType}
            stroke={config[key].color}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    );
  }, [displayState, hasNoData, tooltipActive, data, dataKey, config, lineType]);

  return (
    <div className="relative flex w-full flex-col">
      <div
        className="mt-8 h-full w-full cursor-crosshair"
        style={{ touchAction: "none", userSelect: "none" }}
      >
        <ChartContainer config={config} className="min-h-[200px] w-full">
          {renderChartContent()}
        </ChartContainer>
      </div>
    </div>
  );
}
