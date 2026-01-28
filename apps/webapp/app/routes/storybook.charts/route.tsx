import { ArrowTrendingUpIcon } from "@heroicons/react/20/solid";
import { IconTimeline } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { BigNumber } from "~/components/primitives/charts/BigNumber";
import { Card } from "~/components/primitives/charts/Card";
import { type ChartConfig, type ChartState } from "~/components/primitives/charts/Chart";
import { Chart } from "~/components/primitives/charts/ChartCompound";
import {
  DateRangeProvider,
  formatISODate,
  formatISODateLong,
  useDateRange,
} from "~/components/primitives/charts/DateRangeContext";
import type { ZoomRange } from "~/components/primitives/charts/hooks/useZoomSelection";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioGroup, RadioGroupItem } from "~/components/primitives/RadioButton";
import SegmentedControl from "~/components/primitives/SegmentedControl";

// Date formatters for chart display
const xAxisTickFormatter = (value: string) => formatISODate(value);
const tooltipLabelFormatter = (label: string) => formatISODateLong(label);

/**
 * Helper function to filter chart data by date range.
 * In a real app, this would typically be handled server-side.
 */
function filterDataByDateRange<T extends Record<string, any>>(
  data: T[],
  dataKey: string,
  startDate: string | undefined,
  endDate: string | undefined
): T[] {
  if (!startDate || !endDate) return data;

  const startIndex = data.findIndex((item) => item[dataKey] === startDate);
  const endIndex = data.findIndex((item) => item[dataKey] === endDate);

  if (startIndex === -1 || endIndex === -1) return data;

  const [start, end] = [startIndex, endIndex].sort((a, b) => a - b);
  return data.slice(start, end + 1);
}

function ChartsDashboard() {
  const dateRange = useDateRange();
  const [chartState, setChartState] = useState<ChartState>("loaded");

  // Handle zoom change - updates the shared DateRangeContext
  // In a real app, this would also trigger a server fetch for more granular data
  const handleZoomChange = (range: ZoomRange) => {
    console.log("Zoom changed:", range);
    // Update the shared date range context so all charts sync
    // dateRange?.setDateRange(range.start, range.end);
    // In a real app, you would fetch new data here based on the range:
    // fetchChartData(range.start, range.end).then(setData);
  };

  // Filter data based on the current date range from context
  const filteredBarData = useMemo(
    () =>
      filterDataByDateRange(
        API_DATA.barChartBigDatasetData,
        "day",
        dateRange?.startDate,
        dateRange?.endDate
      ),
    [dateRange?.startDate, dateRange?.endDate]
  );

  const filteredBarData2 = useMemo(
    () =>
      filterDataByDateRange(API_DATA.barChartData, "day", dateRange?.startDate, dateRange?.endDate),
    [dateRange?.startDate, dateRange?.endDate]
  );

  const filteredLineData = useMemo(
    () =>
      filterDataByDateRange(
        API_DATA.lineChartData,
        "day",
        dateRange?.startDate,
        dateRange?.endDate
      ),
    [dateRange?.startDate, dateRange?.endDate]
  );

  return (
    <div className="grid">
      <div className="flex items-center justify-between gap-4 border-b border-charcoal-700 bg-background-bright p-2 pl-3">
        <div className="flex w-fit items-center">
          <RadioGroup
            name="chartState"
            value={chartState}
            onValueChange={(value) => setChartState(value as ChartState)}
            className="flex items-center"
          >
            <RadioGroupItem id="loaded" label="Data loaded" value="loaded" variant="simple/small" />
            <RadioGroupItem
              id="loading"
              label="Data loading"
              value="loading"
              variant="simple/small"
            />
            <RadioGroupItem id="noData" label="No data" value="noData" variant="simple/small" />
            <RadioGroupItem
              id="invalid"
              label="Chart invalid"
              value="invalid"
              variant="simple/small"
            />
          </RadioGroup>
        </div>
        <div className="flex w-fit items-center gap-4">
          <Paragraph variant="small/bright">
            Current range: {dateRange?.startDate ? formatISODate(dateRange.startDate) : ""} -{" "}
            {dateRange?.endDate ? formatISODate(dateRange.endDate) : ""}
          </Paragraph>
          <Button variant="secondary/small" onClick={() => dateRange?.resetDateRange()}>
            Reset Zoom
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 p-3">
        {/* Compound Component API Example */}
        <Card>
          <Card.Header>
            <div className="flex items-center gap-1.5">
              <ArrowTrendingUpIcon className="size-5 text-indigo-500" />
              Compound API <span className="font-normal text-text-dimmed">(with zoom)</span>
            </div>
            <Card.Accessory>
              <SegmentedControl
                name="compoundByStatus"
                options={[
                  { label: "By status", value: "status" },
                  { label: "By task", value: "task" },
                ]}
                defaultValue="status"
                variant="secondary/small"
              />
            </Card.Accessory>
          </Card.Header>
          <Card.Content>
            <Chart.Root
              config={barChartBigDatasetConfig}
              data={filteredBarData}
              dataKey="day"
              labelFormatter={tooltipLabelFormatter}
              enableZoom
              onZoomChange={handleZoomChange}
              state={chartState === "loaded" ? undefined : chartState}
              minHeight="400px"
              showLegend
              maxLegendItems={5}
            >
              <Chart.Bar
                stackId="a"
                referenceLine={{
                  value: 45000,
                  label: "Max concurrency",
                }}
                xAxisProps={{ tickFormatter: xAxisTickFormatter }}
                tooltipLabelFormatter={tooltipLabelFormatter}
              />
            </Chart.Root>
          </Card.Content>
        </Card>


        {/* Simple Line Chart (no zoom, but synced with date range) */}
        <Card>
          <Card.Header>
            <div className="flex items-center gap-1.5">
              <IconTimeline className="size-5 text-indigo-500" />
              Simple Line <span className="font-normal text-text-dimmed">(synced, no zoom)</span>
            </div>
          </Card.Header>
          <Card.Content>
            <Chart.Root
              config={lineChartConfig}
              data={filteredLineData}
              dataKey="day"
              state={chartState === "loaded" ? undefined : chartState}
              showLegend
            >
              <Chart.Line
                lineType="step"
                xAxisProps={{ tickFormatter: xAxisTickFormatter }}
                tooltipLabelFormatter={tooltipLabelFormatter}
              />
            </Chart.Root>
          </Card.Content>
        </Card>

        {/* Line Chart with Zoom */}
        <Card>
          <Card.Header>
            <div className="flex items-center gap-1.5">
              <IconTimeline className="size-5 text-green-500" />
              Line with Zoom
            </div>
          </Card.Header>
          <Card.Content>
            <Chart.Root
              config={lineChartConfig}
              data={filteredLineData}
              dataKey="day"
              enableZoom
              onZoomChange={handleZoomChange}
              state={chartState === "loaded" ? undefined : chartState}
              showLegend
            >
              <Chart.Line
                lineType="natural"
                xAxisProps={{ tickFormatter: xAxisTickFormatter }}
                tooltipLabelFormatter={tooltipLabelFormatter}
              />
            </Chart.Root>
          </Card.Content>
        </Card>

        {/* Stacked Area Chart (synced with date range) */}
        <Card>
          <Card.Header>
            <div className="flex items-center gap-1.5">
              <IconTimeline className="size-5 text-purple-500" />
              Stacked Area <span className="font-normal text-text-dimmed">(synced)</span>
            </div>
          </Card.Header>
          <Card.Content>
            <Chart.Root
              config={lineChartConfig}
              data={filteredLineData}
              dataKey="day"
              state={chartState === "loaded" ? undefined : chartState}
              showLegend
            >
              <Chart.Line
                stacked
                lineType="monotone"
                xAxisProps={{ tickFormatter: xAxisTickFormatter }}
                tooltipLabelFormatter={tooltipLabelFormatter}
              />
            </Chart.Root>
          </Card.Content>
        </Card>

        {/* Big Number */}
        <Card>
          <Card.Header>
            Big Number
            <Card.Accessory>
              <Button variant="secondary/small">Example button</Button>
            </Card.Accessory>
          </Card.Header>
          <Card.Content>
            <BigNumber value={101} suffix="USD" />
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}

export default function Story() {
  return (
    <DateRangeProvider
      defaultStartDate={API_DATA.defaultDateRange.startDate}
      defaultEndDate={API_DATA.defaultDateRange.endDate}
    >
      <ChartsDashboard />
    </DateRangeProvider>
  );
}

// Mock chart data

const API_DATA = {
  defaultDateRange: {
    startDate: new Date(2023, 10, 1), // November 1, 2023
    endDate: new Date(2023, 10, 30), // November 30, 2023
  },
  lineChartData: [
    { day: "2023-11-01", "success-rate": 96.8, "failure-rate": 3.2 },
    { day: "2023-11-02", "success-rate": 95.3, "failure-rate": 4.7 },
    { day: "2023-11-03", "success-rate": 97.1, "failure-rate": 2.9 },
    { day: "2023-11-04", "success-rate": 94.5, "failure-rate": 5.5 },
    { day: "2023-11-05", "success-rate": 98.6, "failure-rate": 1.4 },
    { day: "2023-11-06", "success-rate": 97.8, "failure-rate": 2.2 },
    { day: "2023-11-07", "success-rate": 93.9, "failure-rate": 6.1 },
    { day: "2023-11-08", "success-rate": 95.7, "failure-rate": 4.3 },
    { day: "2023-11-09", "success-rate": 98.2, "failure-rate": 1.8 },
    { day: "2023-11-10", "success-rate": 96.5, "failure-rate": 3.5 },
    { day: "2023-11-11", "success-rate": 94.8, "failure-rate": 5.2 },
    { day: "2023-11-12", "success-rate": 99.1, "failure-rate": 0.9 },
    { day: "2023-11-13", "success-rate": 97.3, "failure-rate": 2.7 },
    { day: "2023-11-14", "success-rate": 95.9, "failure-rate": 4.1 },
    { day: "2023-11-15", "success-rate": 98.4, "failure-rate": 1.6 },
    { day: "2023-11-16", "success-rate": 96.2, "failure-rate": 3.8 },
    { day: "2023-11-17", "success-rate": 94.3, "failure-rate": 5.7 },
    { day: "2023-11-18", "success-rate": 97.5, "failure-rate": 2.5 },
    { day: "2023-11-19", "success-rate": 95.6, "failure-rate": 4.4 },
    { day: "2023-11-20", "success-rate": 98.9, "failure-rate": 1.1 },
    { day: "2023-11-21", "success-rate": 96.7, "failure-rate": 3.3 },
    { day: "2023-11-22", "success-rate": 95.1, "failure-rate": 4.9 },
    { day: "2023-11-23", "success-rate": 97.9, "failure-rate": 2.1 },
    { day: "2023-11-24", "success-rate": 94.7, "failure-rate": 5.3 },
    { day: "2023-11-25", "success-rate": 98.3, "failure-rate": 1.7 },
    { day: "2023-11-26", "success-rate": 96.4, "failure-rate": 3.6 },
    { day: "2023-11-27", "success-rate": 94.9, "failure-rate": 5.1 },
    { day: "2023-11-28", "success-rate": 97.7, "failure-rate": 2.3 },
    { day: "2023-11-29", "success-rate": 95.4, "failure-rate": 4.6 },
    { day: "2023-11-30", "success-rate": 98.8, "failure-rate": 1.2 },
  ],
  barChartData: [
    { day: "2023-11-01", completed: 3245, "in-progress": 4321, canceled: 657, failed: 2987 },
    { day: "2023-11-02", completed: 4567, "in-progress": 3789, canceled: 879, failed: 3456 },
    { day: "2023-11-03", completed: 5432, "in-progress": 4567, canceled: 1234, failed: 2345 },
    { day: "2023-11-04", completed: 0, "in-progress": 5678, canceled: 0, failed: 3678 },
    { day: "2023-11-05", completed: 6789, "in-progress": 3456, canceled: 2345, failed: 4321 },
    { day: "2023-11-06", completed: 3456, "in-progress": 6543, canceled: 1567, failed: 2987 },
    { day: "2023-11-07", completed: 6543, "in-progress": 3456, canceled: 2345, failed: 3456 },
    { day: "2023-11-08", completed: 0, "in-progress": 7654, canceled: 0, failed: 4567 },
    { day: "2023-11-09", completed: 8765, "in-progress": 3245, canceled: 3456, failed: 2109 },
    { day: "2023-11-10", completed: 5432, "in-progress": 6543, canceled: 2109, failed: 3456 },
    { day: "2023-11-11", completed: 3245, "in-progress": 5432, canceled: 1234, failed: 3987 },
    { day: "2023-11-12", completed: 0, "in-progress": 6543, canceled: 0, failed: 3456 },
    { day: "2023-11-13", completed: 7654, "in-progress": 3456, canceled: 2345, failed: 2987 },
    { day: "2023-11-14", completed: 5432, "in-progress": 5432, canceled: 3456, failed: 3421 },
    { day: "2023-11-15", completed: 6543, "in-progress": 4321, canceled: 2109, failed: 2345 },
    { day: "2023-11-16", completed: 0, "in-progress": 7654, canceled: 0, failed: 4567 },
    { day: "2023-11-17", completed: 8765, "in-progress": 3456, canceled: 3421, failed: 2987 },
    { day: "2023-11-18", completed: 5432, "in-progress": 5432, canceled: 2345, failed: 3456 },
    { day: "2023-11-19", completed: 4321, "in-progress": 6543, canceled: 1567, failed: 2987 },
    { day: "2023-11-20", completed: 0, "in-progress": 7654, canceled: 0, failed: 3678 },
    { day: "2023-11-21", completed: 4532, "in-progress": 3456, canceled: 1200, failed: 2876 },
    { day: "2023-11-22", completed: 6789, "in-progress": 4567, canceled: 2345, failed: 3456 },
    { day: "2023-11-23", completed: 5432, "in-progress": 6543, canceled: 0, failed: 2109 },
    { day: "2023-11-24", completed: 6543, "in-progress": 0, canceled: 2345, failed: 0 },
    { day: "2023-11-25", completed: 5432, "in-progress": 0, canceled: 0, failed: 2345 },
    { day: "2023-11-26", completed: 6543, "in-progress": 6543, canceled: 0, failed: 0 },
    { day: "2023-11-27", completed: 8765, "in-progress": 3456, canceled: 0, failed: 5678 },
    { day: "2023-11-28", completed: 5432, "in-progress": 5678, canceled: 4567, failed: 2345 },
    { day: "2023-11-29", completed: 0, "in-progress": 4567, canceled: 2345, failed: 3456 },
    { day: "2023-11-30", completed: 7654, "in-progress": 3456, canceled: 5678, failed: 2345 },
  ],
  barChartBigDatasetData: [
    {
      day: "2023-11-01",
      "sync-data": 6543,
      "process-image": 3245,
      "upload-file": 8765,
      "extract-metadata": 4321,
      "compress-video": 5432,
      "schedule-backup": 0,
      "convert-audio": 6543,
      "analyze-document": 3245,
    },
    {
      day: "2023-11-02",
      "sync-data": 5432,
      "process-image": 0,
      "upload-file": 6789,
      "extract-metadata": 5678,
      "compress-video": 3456,
      "schedule-backup": 7654,
      "convert-audio": 4567,
      "analyze-document": 2345,
    },
    {
      day: "2023-11-03",
      "sync-data": 7654,
      "process-image": 5432,
      "upload-file": 0,
      "extract-metadata": 6543,
      "compress-video": 4321,
      "schedule-backup": 3456,
      "convert-audio": 5678,
      "analyze-document": 6543,
    },
    {
      day: "2023-11-04",
      "sync-data": 3456,
      "process-image": 6543,
      "upload-file": 7654,
      "extract-metadata": 0,
      "compress-video": 6789,
      "schedule-backup": 5432,
      "convert-audio": 3456,
      "analyze-document": 4567,
    },
    {
      day: "2023-11-05",
      "sync-data": 0,
      "process-image": 8765,
      "upload-file": 4567,
      "extract-metadata": 7654,
      "compress-video": 5432,
      "schedule-backup": 6543,
      "convert-audio": 0,
      "analyze-document": 7654,
    },
    {
      day: "2023-11-06",
      "sync-data": 6789,
      "process-image": 4321,
      "upload-file": 5432,
      "extract-metadata": 6543,
      "compress-video": 0,
      "schedule-backup": 8765,
      "convert-audio": 5432,
      "analyze-document": 3456,
    },
    {
      day: "2023-11-07",
      "sync-data": 7654,
      "process-image": 0,
      "upload-file": 6789,
      "extract-metadata": 5432,
      "compress-video": 7654,
      "schedule-backup": 4321,
      "convert-audio": 6543,
      "analyze-document": 0,
    },
    {
      day: "2023-11-08",
      "sync-data": 5678,
      "process-image": 6543,
      "upload-file": 0,
      "extract-metadata": 8765,
      "compress-video": 5432,
      "schedule-backup": 6543,
      "convert-audio": 4321,
      "analyze-document": 7654,
    },
    {
      day: "2023-11-09",
      "sync-data": 0,
      "process-image": 7654,
      "upload-file": 5432,
      "extract-metadata": 6543,
      "compress-video": 8765,
      "schedule-backup": 0,
      "convert-audio": 7654,
      "analyze-document": 5432,
    },
    {
      day: "2023-11-10",
      "sync-data": 8765,
      "process-image": 5432,
      "upload-file": 7654,
      "extract-metadata": 0,
      "compress-video": 6543,
      "schedule-backup": 7654,
      "convert-audio": 5432,
      "analyze-document": 6543,
    },
    {
      day: "2023-11-11",
      "sync-data": 6543,
      "process-image": 0,
      "upload-file": 8765,
      "extract-metadata": 5432,
      "compress-video": 7654,
      "schedule-backup": 5432,
      "convert-audio": 0,
      "analyze-document": 8765,
    },
    {
      day: "2023-11-12",
      "sync-data": 5432,
      "process-image": 7654,
      "upload-file": 0,
      "extract-metadata": 6543,
      "compress-video": 5432,
      "schedule-backup": 7654,
      "convert-audio": 6543,
      "analyze-document": 5432,
    },
    {
      day: "2023-11-13",
      "sync-data": 0,
      "process-image": 6543,
      "upload-file": 7654,
      "extract-metadata": 5432,
      "compress-video": 0,
      "schedule-backup": 8765,
      "convert-audio": 5432,
      "analyze-document": 7654,
    },
    {
      day: "2023-11-14",
      "sync-data": 7654,
      "process-image": 5432,
      "upload-file": 6543,
      "extract-metadata": 0,
      "compress-video": 7654,
      "schedule-backup": 5432,
      "convert-audio": 8765,
      "analyze-document": 0,
    },
    {
      day: "2023-11-15",
      "sync-data": 6543,
      "process-image": 0,
      "upload-file": 8765,
      "extract-metadata": 7654,
      "compress-video": 5432,
      "schedule-backup": 6543,
      "convert-audio": 5432,
      "analyze-document": 7654,
    },
    {
      day: "2023-11-16",
      "sync-data": 5432,
      "process-image": 7654,
      "upload-file": 0,
      "extract-metadata": 6543,
      "compress-video": 8765,
      "schedule-backup": 0,
      "convert-audio": 7654,
      "analyze-document": 5432,
    },
    {
      day: "2023-11-17",
      "sync-data": 0,
      "process-image": 6543,
      "upload-file": 7654,
      "extract-metadata": 5432,
      "compress-video": 6543,
      "schedule-backup": 7654,
      "convert-audio": 5432,
      "analyze-document": 0,
    },
    {
      day: "2023-11-18",
      "sync-data": 8765,
      "process-image": 0,
      "upload-file": 6543,
      "extract-metadata": 0,
      "compress-video": 7654,
      "schedule-backup": 5432,
      "convert-audio": 6543,
      "analyze-document": 7654,
    },
    {
      day: "2023-11-19",
      "sync-data": 5432,
      "process-image": 7654,
      "upload-file": 0,
      "extract-metadata": 6543,
      "compress-video": 5432,
      "schedule-backup": 0,
      "convert-audio": 7654,
      "analyze-document": 5432,
    },
    {
      day: "2023-11-20",
      "sync-data": 6543,
      "process-image": 5432,
      "upload-file": 7654,
      "extract-metadata": 0,
      "compress-video": 6543,
      "schedule-backup": 7654,
      "convert-audio": 5432,
      "analyze-document": 0,
    },
    {
      day: "2023-11-21",
      "sync-data": 8765,
      "process-image": 4532,
      "upload-file": 0,
      "extract-metadata": 6789,
      "compress-video": 3456,
      "schedule-backup": 0,
      "convert-audio": 5432,
      "analyze-document": 7654,
    },
    {
      day: "2023-11-22",
      "sync-data": 5432,
      "process-image": 0,
      "upload-file": 6789,
      "extract-metadata": 4567,
      "compress-video": 0,
      "schedule-backup": 8765,
      "convert-audio": 3456,
      "analyze-document": 5678,
    },
    {
      day: "2023-11-23",
      "sync-data": 0,
      "process-image": 6789,
      "upload-file": 4567,
      "extract-metadata": 0,
      "compress-video": 7654,
      "schedule-backup": 3456,
      "convert-audio": 0,
      "analyze-document": 5432,
    },
    {
      day: "2023-11-24",
      "sync-data": 9876,
      "process-image": 3456,
      "upload-file": 5678,
      "extract-metadata": 0,
      "compress-video": 4567,
      "schedule-backup": 2345,
      "convert-audio": 6789,
      "analyze-document": 0,
    },
    {
      day: "2023-11-25",
      "sync-data": 5432,
      "process-image": 0,
      "upload-file": 8765,
      "extract-metadata": 3456,
      "compress-video": 5678,
      "schedule-backup": 0,
      "convert-audio": 4567,
      "analyze-document": 7654,
    },
    {
      day: "2023-11-26",
      "sync-data": 0,
      "process-image": 7654,
      "upload-file": 3456,
      "extract-metadata": 5678,
      "compress-video": 0,
      "schedule-backup": 6789,
      "convert-audio": 3456,
      "analyze-document": 5678,
    },
    {
      day: "2023-11-27",
      "sync-data": 8765,
      "process-image": 3456,
      "upload-file": 0,
      "extract-metadata": 5678,
      "compress-video": 3456,
      "schedule-backup": 5678,
      "convert-audio": 0,
      "analyze-document": 6789,
    },
    {
      day: "2023-11-28",
      "sync-data": 5678,
      "process-image": 0,
      "upload-file": 7654,
      "extract-metadata": 3456,
      "compress-video": 5678,
      "schedule-backup": 3456,
      "convert-audio": 7654,
      "analyze-document": 0,
    },
    {
      day: "2023-11-29",
      "sync-data": 0,
      "process-image": 8765,
      "upload-file": 3456,
      "extract-metadata": 0,
      "compress-video": 6789,
      "schedule-backup": 3456,
      "convert-audio": 5678,
      "analyze-document": 7654,
    },
    {
      day: "2023-11-30",
      "sync-data": 7654,
      "process-image": 3456,
      "upload-file": 5678,
      "extract-metadata": 7654,
      "compress-video": 5432,
      "schedule-backup": 6789,
      "convert-audio": 3456,
      "analyze-document": 5678,
    },
  ],
};

const lineChartConfig = {
  "success-rate": {
    label: "Success Rate",
    color: "#22C55E",
  },
  "failure-rate": {
    label: "Failure Rate",
    color: "#F43F5E",
  },
} satisfies ChartConfig;

const barChartBigDatasetConfig = {
  "sync-data": {
    label: (
      <div className="flex items-center gap-2">
        <span>sync-data</span>
        <span className="text-text-dimmed/50">7fj29d0ksl38ac5q</span>
      </div>
    ),
    color: "#3B82F6",
  },
  "process-image": {
    label: (
      <div className="flex items-center gap-2">
        <span>process-image</span>
        <span className="text-text-dimmed/50">3lk49c7fm2d8r6p0</span>
      </div>
    ),
    color: "#22C55E",
  },
  "upload-file": {
    label: (
      <div className="flex items-center gap-2">
        <span>upload-file</span>
        <span className="text-text-dimmed/50">j8k2p3d9f7a6s5l0</span>
      </div>
    ),
    color: "#F59E0B",
  },
  "extract-metadata": {
    label: (
      <div className="flex items-center gap-2">
        <span>extract-metadata</span>
        <span className="text-text-dimmed/50">q7w6e5r4t3y2u1i0</span>
      </div>
    ),
    color: "#F43F5E",
  },
  "compress-video": {
    label: (
      <div className="flex items-center gap-2">
        <span>compress-video</span>
        <span className="text-text-dimmed/50">a2s3d4f5g6h7j8k9</span>
      </div>
    ),
    color: "#8B5CF6",
  },
  "schedule-backup": {
    label: (
      <div className="flex items-center gap-2">
        <span>schedule-backup</span>
        <span className="text-text-dimmed/50">z1x2c3v4b5n6m7l8</span>
      </div>
    ),
    color: "#06B6D4",
  },
  "convert-audio": {
    label: (
      <div className="flex items-center gap-2">
        <span>convert-audio</span>
        <span className="text-text-dimmed/50">p0o9i8u7y6t5r4e3</span>
      </div>
    ),
    color: "#EC4899",
  },
  "analyze-document": {
    label: (
      <div className="flex items-center gap-2">
        <span>analyze-document</span>
        <span className="text-text-dimmed/50">m2n3b4v5c6x7z8l9</span>
      </div>
    ),
    color: "#F97316",
  },
} satisfies ChartConfig;
