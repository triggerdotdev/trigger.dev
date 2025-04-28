import { ArrowTrendingUpIcon } from "@heroicons/react/20/solid";
import { useState } from "react";
import { AbacusIcon } from "~/assets/icons/AbacusIcon";
import { ArrowTopRightBottomLeftIcon } from "~/assets/icons/ArrowTopRightBottomLeftIcon";
import { Button } from "~/components/primitives/Buttons";
import { BigNumber } from "~/components/primitives/charts/BigNumber";
import { Card } from "~/components/primitives/charts/Card";
import { type ChartState, type ChartConfig } from "~/components/primitives/charts/Chart";
import { ChartBar } from "~/components/primitives/charts/ChartBar";
import { ChartLine } from "~/components/primitives/charts/ChartLine";
import { DateRangeProvider, useDateRange } from "~/components/primitives/charts/DateRangeContext";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioGroup, RadioGroupItem } from "~/components/primitives/RadioButton";
import SegmentedControl from "~/components/primitives/SegmentedControl";

function ChartsDashboard() {
  const dateRange = useDateRange();
  const [chartState, setChartState] = useState<ChartState>("loaded");

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
          <Paragraph variant="small/bright">{`Selected range: ${dateRange.startDate} - ${dateRange.endDate}`}</Paragraph>
          <Button variant="secondary/small" onClick={dateRange.resetDateRange}>
            Reset Zoom
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 p-3">
        <Card>
          <Card.Header>
            <div className="flex items-center gap-1.5">
              <ArrowTrendingUpIcon className="size-5 text-indigo-500" />
              Runs total
            </div>
            <Card.Accessory>
              <SegmentedControl
                name="runsByStatus"
                options={[
                  { label: "By status", value: "status" },
                  { label: "By task", value: "task" },
                ]}
                defaultValue="status"
                variant="secondary/small"
              />
              <Button
                variant="secondary/small"
                TrailingIcon={<ArrowTopRightBottomLeftIcon className="size-4" />}
                className="px-1"
              />
            </Card.Accessory>
          </Card.Header>
          <Card.Content>
            <ChartBar
              config={barChartBigDatasetConfig}
              data={API_DATA.barChartBigDatasetData}
              dataKey="day"
              stackId="a"
              useGlobalDateRange={true}
              referenceLine={{
                value: 45000,
                label: "Max concurrency",
              }}
              state={chartState === "loaded" ? undefined : chartState}
              minHeight="400px"
            />
          </Card.Content>
        </Card>
        <Card>
          <Card.Header>
            <div className="flex items-center gap-1.5">
              <AbacusIcon className="size-5 text-indigo-500" />
              Run count <span className="font-normal text-text-dimmed">by status</span>
            </div>
            <Card.Accessory>
              <SegmentedControl
                name="runCountByStatus"
                options={[
                  { label: "By status", value: "status" },
                  { label: "By task", value: "task" },
                ]}
                defaultValue="status"
                variant="secondary/small"
              />
              <Button
                variant="secondary/small"
                TrailingIcon={<ArrowTopRightBottomLeftIcon className="size-4" />}
                className="px-1"
              />
            </Card.Accessory>
          </Card.Header>
          <Card.Content>
            <ChartBar
              config={barChartConfig}
              data={API_DATA.barChartData}
              dataKey="day"
              stackId="a"
              useGlobalDateRange={true}
              referenceLine={{
                value: 30000,
                label: "Max concurrency",
              }}
              state={chartState === "loaded" ? undefined : chartState}
              minHeight="400px"
            />
          </Card.Content>
        </Card>
        <Card>
          <Card.Header>Line Chart</Card.Header>
          <Card.Content>
            <ChartLine
              config={lineChartConfig}
              data={API_DATA.lineChartData}
              dataKey="day"
              useGlobalDateRange={true}
              state={chartState === "loaded" ? undefined : chartState}
            />
          </Card.Content>
        </Card>
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
    { day: "Nov 1", desktop: 156, mobile: 89 },
    { day: "Nov 2", desktop: 187, mobile: 102 },
    { day: "Nov 3", desktop: 215, mobile: 95 },
    { day: "Nov 4", desktop: 203, mobile: 114 },
    { day: "Nov 5", desktop: 148, mobile: 81 },
    { day: "Nov 6", desktop: 178, mobile: 110 },
    { day: "Nov 7", desktop: 225, mobile: 132 },
    { day: "Nov 8", desktop: 243, mobile: 145 },
    { day: "Nov 9", desktop: 201, mobile: 118 },
    { day: "Nov 10", desktop: 176, mobile: 97 },
    { day: "Nov 11", desktop: 132, mobile: 78 },
    { day: "Nov 12", desktop: 145, mobile: 85 },
    { day: "Nov 13", desktop: 189, mobile: 103 },
    { day: "Nov 14", desktop: 232, mobile: 128 },
    { day: "Nov 15", desktop: 256, mobile: 142 },
    { day: "Nov 16", desktop: 276, mobile: 159 },
    { day: "Nov 17", desktop: 287, mobile: 168 },
    { day: "Nov 18", desktop: 243, mobile: 146 },
    { day: "Nov 19", desktop: 198, mobile: 125 },
    { day: "Nov 20", desktop: 212, mobile: 117 },
    { day: "Nov 21", desktop: 186, mobile: 80 },
    { day: "Nov 22", desktop: 305, mobile: 200 },
    { day: "Nov 23", desktop: 237, mobile: 120 },
    { day: "Nov 24", desktop: 173, mobile: 190 },
    { day: "Nov 25", desktop: 209, mobile: 130 },
    { day: "Nov 26", desktop: 214, mobile: 140 },
    { day: "Nov 27", desktop: 546, mobile: 150 },
    { day: "Nov 28", desktop: 432, mobile: 165 },
    { day: "Nov 29", desktop: 387, mobile: 139 },
    { day: "Nov 30", desktop: 423, mobile: 157 },
  ],
  barChartData: [
    { day: "Nov 1", completed: 3245, "in-progress": 4321, canceled: 657, failed: 2987 },
    { day: "Nov 2", completed: 4567, "in-progress": 3789, canceled: 879, failed: 3456 },
    { day: "Nov 3", completed: 5432, "in-progress": 4567, canceled: 1234, failed: 2345 },
    { day: "Nov 4", completed: 0, "in-progress": 5678, canceled: 0, failed: 3678 },
    { day: "Nov 5", completed: 6789, "in-progress": 3456, canceled: 2345, failed: 4321 },
    { day: "Nov 6", completed: 3456, "in-progress": 6543, canceled: 1567, failed: 2987 },
    { day: "Nov 7", completed: 6543, "in-progress": 3456, canceled: 2345, failed: 3456 },
    { day: "Nov 8", completed: 0, "in-progress": 7654, canceled: 0, failed: 4567 },
    { day: "Nov 9", completed: 8765, "in-progress": 3245, canceled: 3456, failed: 2109 },
    { day: "Nov 10", completed: 5432, "in-progress": 6543, canceled: 2109, failed: 3456 },
    { day: "Nov 11", completed: 3245, "in-progress": 5432, canceled: 1234, failed: 3987 },
    { day: "Nov 12", completed: 0, "in-progress": 6543, canceled: 0, failed: 3456 },
    { day: "Nov 13", completed: 7654, "in-progress": 3456, canceled: 2345, failed: 2987 },
    { day: "Nov 14", completed: 5432, "in-progress": 5432, canceled: 3456, failed: 3421 },
    { day: "Nov 15", completed: 6543, "in-progress": 4321, canceled: 2109, failed: 2345 },
    { day: "Nov 16", completed: 0, "in-progress": 7654, canceled: 0, failed: 4567 },
    { day: "Nov 17", completed: 8765, "in-progress": 3456, canceled: 3421, failed: 2987 },
    { day: "Nov 18", completed: 5432, "in-progress": 5432, canceled: 2345, failed: 3456 },
    { day: "Nov 19", completed: 4321, "in-progress": 6543, canceled: 1567, failed: 2987 },
    { day: "Nov 20", completed: 0, "in-progress": 7654, canceled: 0, failed: 3678 },
    { day: "Nov 21", completed: 4532, "in-progress": 3456, canceled: 1200, failed: 2876 },
    { day: "Nov 22", completed: 6789, "in-progress": 4567, canceled: 2345, failed: 3456 },
    { day: "Nov 23", completed: 5432, "in-progress": 6543, canceled: 0, failed: 2109 },
    { day: "Nov 24", completed: 6543, "in-progress": 0, canceled: 2345, failed: 0 },
    { day: "Nov 25", completed: 5432, "in-progress": 0, canceled: 0, failed: 2345 },
    { day: "Nov 26", completed: 6543, "in-progress": 6543, canceled: 0, failed: 0 },
    { day: "Nov 27", completed: 8765, "in-progress": 3456, canceled: 0, failed: 5678 },
    { day: "Nov 28", completed: 5432, "in-progress": 5678, canceled: 4567, failed: 2345 },
    { day: "Nov 29", completed: 0, "in-progress": 4567, canceled: 2345, failed: 3456 },
    { day: "Nov 30", completed: 7654, "in-progress": 3456, canceled: 5678, failed: 2345 },
  ],
  barChartBigDatasetData: [
    {
      day: "Nov 1",
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
      day: "Nov 2",
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
      day: "Nov 3",
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
      day: "Nov 4",
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
      day: "Nov 5",
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
      day: "Nov 6",
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
      day: "Nov 7",
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
      day: "Nov 8",
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
      day: "Nov 9",
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
      day: "Nov 10",
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
      day: "Nov 11",
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
      day: "Nov 12",
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
      day: "Nov 13",
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
      day: "Nov 14",
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
      day: "Nov 15",
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
      day: "Nov 16",
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
      day: "Nov 17",
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
      day: "Nov 18",
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
      day: "Nov 19",
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
      day: "Nov 20",
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
      day: "Nov 21",
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
      day: "Nov 22",
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
      day: "Nov 23",
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
      day: "Nov 24",
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
      day: "Nov 25",
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
      day: "Nov 26",
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
      day: "Nov 27",
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
      day: "Nov 28",
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
      day: "Nov 29",
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
      day: "Nov 30",
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
  desktop: {
    label: "Desktop",
    color: "#3B82F6",
  },
  mobile: {
    label: "Mobile",
    color: "#28BF5C",
  },
} satisfies ChartConfig;

const barChartConfig = {
  completed: {
    label: "Completed",
    color: "#28BF5C",
  },
  "in-progress": {
    label: "In Progress",
    color: "#3B82F6",
  },
  canceled: {
    label: "Canceled",
    color: "#878C99",
  },
  failed: {
    label: "Failed",
    color: "#E11D48",
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
