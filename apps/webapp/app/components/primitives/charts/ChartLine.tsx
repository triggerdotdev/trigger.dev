import React from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartState,
} from "~/components/primitives/charts/Chart";
import { ChartLineLoading } from "./ChartLoading";
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

  // Compute the visible data based on the date range
  const data = React.useMemo(() => {
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

  return (
    <div className="relative flex w-full flex-col">
      <div
        className="mt-8 h-full w-full cursor-crosshair"
        style={{ touchAction: "none", userSelect: "none" }}
      >
        <ChartContainer config={config} className="min-h-[200px] w-full">
          {state === "loading" ? (
            <ChartLineLoading />
          ) : (
            <LineChart
              accessibilityLayer
              data={data}
              margin={{
                left: 12,
                right: 12,
              }}
            >
              <CartesianGrid vertical={false} stroke="#272A2E" />
              <XAxis
                dataKey={dataKey}
                tickLine={false}
                axisLine={false}
                tickMargin={10}
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
                />
              ))}
            </LineChart>
          )}
        </ChartContainer>
      </div>
    </div>
  );
}
