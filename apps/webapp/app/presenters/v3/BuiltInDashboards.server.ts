import { type BuiltInDashboard } from "./MetricDashboardPresenter.server";
import { z } from "zod";

const overviewDashboard: BuiltInDashboard = {
  key: "overview",
  title: "Metrics",
  layout: {
    version: "1",
    layout: [
      { i: "9lDDdebQ", x: 3, y: 0, w: 3, h: 4 },
      { i: "VhAgNlB0", x: 0, y: 0, w: 3, h: 4 },
      { i: "iI5EnhJW", x: 6, y: 0, w: 3, h: 4 },
      { i: "HtSgJEmp", x: 0, y: 17, w: 12, h: 2, minH: 2, maxH: 2 },
      { i: "rRbzv-Aq", x: 6, y: 4, w: 6, h: 13 },
      { i: "j3yFSxLM", x: 0, y: 33, w: 6, h: 11 },
      { i: "IKB8cENo", x: 6, y: 33, w: 6, h: 11 },
      { i: "-fHz3CyQ", x: 0, y: 56, w: 12, h: 2, minH: 2, maxH: 2 },
      { i: "hnKsN482", x: 0, y: 58, w: 12, h: 15 },
      { i: "if6dds8T", x: 0, y: 19, w: 12, h: 14 },
      { i: "i3q1Awfz", x: 0, y: 4, w: 6, h: 13 },
      { i: "Kh0w0fjy", x: 6, y: 44, w: 6, h: 12 },
      { i: "zybRTAdz", x: 0, y: 44, w: 6, h: 12 },
      { i: "ff2nVxxt", x: 0, y: 73, w: 12, h: 15 },
      { i: "Dib0ywb4", x: 0, y: 88, w: 12, h: 2, minH: 2, maxH: 2 },
      { i: "YsWiQENd", x: 0, y: 90, w: 12, h: 15 },
      { i: "lc-guCvo", x: 0, y: 105, w: 12, h: 15 },
      { i: "xyQl3FAd", x: 9, y: 0, w: 3, h: 4 },
    ],
    widgets: {
      "9lDDdebQ": {
        title: "Total runs",
        query: "SELECT\r\n  count() AS total_runs\r\nFROM\r\n  runs\r\nLIMIT\r\n  100",
        display: { type: "bignumber", column: "total_runs", aggregation: "sum", abbreviate: false },
      },
      VhAgNlB0: {
        title: "Success %",
        query:
          "SELECT\r\n  round(countIf (status = 'Completed') * 100.0 / countIf (is_finished = 1), 2) AS success_percentage\r\nFROM\r\n  runs\r\nLIMIT\r\n  100",
        display: {
          type: "bignumber",
          column: "success_percentage",
          aggregation: "sum",
          abbreviate: true,
          suffix: "%",
        },
      },
      iI5EnhJW: {
        title: "Failed runs",
        query:
          "SELECT\r\n  count() AS total_runs\r\nFROM\r\n  runs\r\nWHERE status IN ('Failed', 'System failure', 'Crashed')\r\nLIMIT\r\n  100",
        display: { type: "bignumber", column: "total_runs", aggregation: "sum", abbreviate: false },
      },
      HtSgJEmp: { title: "Failed runs", query: "", display: { type: "title" } },
      "rRbzv-Aq": {
        title: "Runs by status",
        query:
          "SELECT\r\n  timeBucket (),\r\n  status,\r\n  count() AS run_count\r\nFROM\r\n  runs\r\nGROUP BY\r\n  timeBucket,\r\n  status\r\nORDER BY\r\n  timeBucket\r\nLIMIT\r\n  100",
        display: {
          type: "chart",
          chartType: "bar",
          xAxisColumn: "timebucket",
          yAxisColumns: ["run_count"],
          groupByColumn: "status",
          stacked: true,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "sum",
        },
      },
      j3yFSxLM: {
        title: "Top failing tasks",
        query:
          "SELECT\r\n  task_identifier AS task,\r\n  count() AS runs,\r\n  countIf (status IN ('Failed', 'Crashed', 'System failure')) AS failures,\r\n  concat(round((countIf (status IN ('Failed', 'Crashed', 'System failure')) / count()) * 100, 2), '%') AS failure_rate,\r\n  avg(attempt_count - 1) AS avg_retries\r\nFROM\r\n  runs\r\nGROUP BY\r\n  task_identifier\r\nORDER BY\r\n  (countIf (status IN ('Failed', 'Crashed', 'System failure')) / count()) DESC\r\nLIMIT\r\n  100;",
        display: { type: "table", prettyFormatting: true, sorting: [] },
      },
      IKB8cENo: {
        title: "Top failing tags",
        query:
          "SELECT\r\n  arrayJoin(tags) AS tag,\r\n  count() AS runs,\r\n  countIf (status IN ('Failed', 'Crashed', 'System failure')) AS failures,\r\n  concat(round((countIf (status IN ('Failed', 'Crashed', 'System failure')) / count()) * 100, 2), '%') AS failure_rate,\r\n  avg(attempt_count - 1) AS avg_retries\r\nFROM\r\n  runs\r\nGROUP BY\r\n  tag\r\nORDER BY\r\n  (countIf (status IN ('Failed', 'Crashed', 'System failure')) / count()) DESC\r\nLIMIT\r\n  100;",
        display: { type: "table", prettyFormatting: true, sorting: [] },
      },
      "-fHz3CyQ": { title: "Usage and cost", query: "", display: { type: "title" } },
      hnKsN482: {
        title: "Cost by task",
        query:
          "SELECT\r\n  timeBucket() as time_period,\r\n  task_identifier,\r\n  sum(total_cost) AS total_cost\r\nFROM\r\n  runs\r\nGROUP BY\r\n  time_period,\r\n  task_identifier\r\nORDER BY\r\n  time_period\r\nLIMIT\r\n  100",
        display: {
          type: "chart",
          chartType: "line",
          xAxisColumn: "time_period",
          yAxisColumns: ["total_cost"],
          groupByColumn: "task_identifier",
          stacked: true,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "sum",
        },
      },
      if6dds8T: {
        title: "Failed runs by task",
        query:
          "SELECT\r\n  timeBucket () as time_period,\r\n  task_identifier,\r\n  count() AS run_count\r\nFROM\r\n  runs\r\nWHERE status IN ('Failed', 'Crashed', 'System failure')\r\nGROUP BY\r\n  time_period,\r\n  task_identifier\r\nORDER BY\r\n  time_period\r\nLIMIT\r\n  100",
        display: {
          type: "chart",
          chartType: "bar",
          xAxisColumn: "time_period",
          yAxisColumns: ["run_count"],
          groupByColumn: "task_identifier",
          stacked: true,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "sum",
        },
      },
      i3q1Awfz: {
        title: "Run success",
        query:
          "SELECT\r\n  timeBucket (),\r\n  count() as total,\r\n  countIf (status = 'Completed') / total * 100 AS completed,\r\n  countIf (status IN ('Failed', 'Crashed', 'System failure')) / total * 100 AS failed,\r\nFROM\r\n  runs\r\nGROUP BY\r\n  timeBucket\r\nORDER BY\r\n  timeBucket",
        display: {
          type: "chart",
          chartType: "line",
          xAxisColumn: "timebucket",
          yAxisColumns: ["failed", "completed"],
          groupByColumn: null,
          stacked: false,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "sum",
          seriesColors: { failed: "#f43f5e" },
        },
      },
      Kh0w0fjy: {
        title: "Top errors",
        query:
          "SELECT\r\n  concat(error.name, '(\"', error.message, '\")') AS error,\r\n  count() AS count\r\nFROM\r\n  runs\r\nWHERE\r\n  runs.error != NULL\r\n  AND runs.error.name != NULL\r\nGROUP BY\r\n  error\r\nORDER BY\r\n  count DESC\r\nLIMIT\r\n  100",
        display: { type: "table", prettyFormatting: true, sorting: [] },
      },
      zybRTAdz: {
        title: "Top errors over time",
        query:
          "SELECT\r\n  timeBucket(),\r\n  concat(error.name, '(\"', error.message, '\")') AS error,\r\n  count() AS count\r\nFROM\r\n  runs\r\nWHERE\r\n  runs.error != NULL\r\n  AND runs.error.name != NULL\r\nGROUP BY\r\n  timeBucket,\r\n  error\r\nORDER BY\r\n  count DESC\r\nLIMIT\r\n  100",
        display: {
          type: "chart",
          chartType: "bar",
          xAxisColumn: "timebucket",
          yAxisColumns: ["count"],
          groupByColumn: "error",
          stacked: true,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "sum",
          seriesColors: { count: "#ef4343" },
        },
      },
      ff2nVxxt: {
        title: "Cost by machine",
        query:
          "SELECT\r\n  timeBucket() as time_period,\r\n  machine,\r\n  sum(total_cost) AS total_cost\r\nFROM\r\n  runs\r\nWHERE machine != ''\r\nGROUP BY\r\n  time_period,\r\n  machine\r\nORDER BY\r\n  time_period\r\nLIMIT\r\n  100",
        display: {
          type: "chart",
          chartType: "line",
          xAxisColumn: "time_period",
          yAxisColumns: ["total_cost"],
          groupByColumn: "machine",
          stacked: true,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "sum",
        },
      },
      Dib0ywb4: { title: "Versions", query: "", display: { type: "title" } },
      YsWiQENd: {
        title: "Runs by version",
        query:
          "SELECT\r\n  timeBucket (),\r\n  task_version,\r\n  count() as runs\r\nFROM\r\n  runs\r\nWHERE task_version != ''\r\nGROUP BY\r\n  timeBucket,\r\n  task_version\r\nORDER BY\r\n  timeBucket",
        display: {
          type: "chart",
          chartType: "line",
          xAxisColumn: "timebucket",
          yAxisColumns: ["runs"],
          groupByColumn: "task_version",
          stacked: false,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "sum",
          seriesColors: {},
        },
      },
      "lc-guCvo": {
        title: "Version success %",
        query:
          "SELECT\r\n  timeBucket (),\r\n  task_version,\r\n  count() as total,\r\n  countIf (status = 'Completed') / total * 100 AS success\r\nFROM\r\n  runs\r\nWHERE task_version != ''\r\nGROUP BY\r\n  timeBucket,\r\n  task_version\r\nORDER BY\r\n  timeBucket",
        display: {
          type: "chart",
          chartType: "line",
          xAxisColumn: "timebucket",
          yAxisColumns: ["success"],
          groupByColumn: "task_version",
          stacked: false,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "sum",
          seriesColors: {},
        },
      },
      xyQl3FAd: {
        title: "Queued",
        query:
          "SELECT\r\n  count() AS queued\r\nFROM\r\n  runs\r\nWHERE status IN ('Dequeued', 'Queued')\r\nLIMIT\r\n  100",
        display: { type: "bignumber", column: "queued", aggregation: "sum", abbreviate: false },
      },
    },
  },
};

const builtInDashboards: BuiltInDashboard[] = [overviewDashboard];

export function builtInDashboard(key: string): BuiltInDashboard {
  const dashboard = builtInDashboards.find((d) => d.key === key);
  if (!dashboard) {
    throw new Error(`No built-in dashboard "${key}"`);
  }

  return dashboard;
}
