import React from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "~/components/primitives/charts/Chart";
import { ChartLoading } from "./ChartLoading";
import { useDateRange } from "./DateRangeContext";

export function ChartLine({
  config,
  data: initialData,
  dataKey,
  loading = false,
  useGlobalDateRange = false,
}: {
  config: ChartConfig;
  data: any[];
  dataKey: string;
  loading?: boolean;
  useGlobalDateRange?: boolean;
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
        console.warn(
          `Date range not found in data. Start: ${globalDateRange.startDate}, End: ${globalDateRange.endDate}`
        );
        console.log("Available dates:", allDays);
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
    <ChartContainer config={config} className="min-h-[200px] w-full">
      {loading ? (
        <ChartLoading />
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
          <XAxis dataKey={dataKey} tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis axisLine={false} tickLine={false} tickMargin={8} />
          <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
          {Object.keys(config).map((key) => (
            <Line
              key={key}
              dataKey={key}
              type="step"
              stroke={config[key].color}
              strokeWidth={2}
              dot={false}
            />
          ))}
        </LineChart>
      )}
    </ChartContainer>
  );
}
