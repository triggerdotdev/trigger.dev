import type { OutputColumnMetadata } from "@internal/clickhouse";
import type { ChartConfiguration } from "~/components/metrics/QueryWidget";

const demoChartColumns: OutputColumnMetadata[] = [
  { name: "hour", type: "DateTime" },
  { name: "task_identifier", type: "String" },
  { name: "failures", type: "UInt64", format: "quantity" },
];

const SERIES: Record<string, number[]> = {
  "send-order-receipt": [1, 0, 2, 1, 3, 2, 4, 9, 14, 22, 31, 41],
  "generate-monthly-report": [0, 1, 0, 0, 1, 0, 2, 1, 0, 1, 2, 1],
  "sync-crm-contacts": [3, 2, 4, 3, 2, 3, 2, 4, 3, 2, 3, 2],
};

const START_MS = Date.parse("2026-07-26T23:00:00.000Z");
const HOUR_MS = 3_600_000;

const demoChartRows: Record<string, unknown>[] = Object.entries(SERIES).flatMap(([task, points]) =>
  points.map((failures, i) => ({
    hour: new Date(START_MS + i * HOUR_MS).toISOString(),
    task_identifier: task,
    failures,
  }))
);

const demoChartConfig: ChartConfiguration = {
  chartType: "line",
  xAxisColumn: "hour",
  yAxisColumns: ["failures"],
  groupByColumn: "task_identifier",
  stacked: false,
  sortByColumn: null,
  sortDirection: "desc",
  aggregation: "sum",
};

const demoChartTimeRange = {
  from: new Date(START_MS).toISOString(),
  to: new Date(START_MS + 11 * HOUR_MS).toISOString(),
};

export const demoChart = {
  rows: demoChartRows,
  columns: demoChartColumns,
  config: demoChartConfig,
  timeRange: demoChartTimeRange,
  title: "Failed runs per hour, by task",
} as const;
