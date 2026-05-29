import { type BuiltInDashboard } from "./MetricDashboardPresenter.server";
import { z } from "zod";

const overviewDashboard: BuiltInDashboard = {
  key: "overview",
  title: "Metrics",
  filters: ["tasks", "queues"],
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
        query: "SELECT\r\n  count() AS total_runs\r\nFROM\r\n  runs",
        display: { type: "bignumber", column: "total_runs", aggregation: "sum", abbreviate: false },
      },
      VhAgNlB0: {
        title: "Success %",
        query:
          "SELECT\r\n  round(countIf (status = 'Completed') * 100.0 / countIf (is_finished = 1), 2) AS success_percentage\r\nFROM\r\n  runs",
        display: {
          type: "bignumber",
          column: "success_percentage",
          aggregation: "avg",
          abbreviate: true,
          suffix: "%",
        },
      },
      iI5EnhJW: {
        title: "Failed runs",
        query:
          "SELECT\r\n  count() AS total_runs\r\nFROM\r\n  runs\r\nWHERE status IN ('Failed', 'System failure', 'Crashed')",
        display: { type: "bignumber", column: "total_runs", aggregation: "sum", abbreviate: false },
      },
      HtSgJEmp: { title: "Failed runs", query: "", display: { type: "title" } },
      "rRbzv-Aq": {
        title: "Runs by status",
        query:
          "SELECT\r\n  timeBucket (),\r\n  status,\r\n  count() AS run_count\r\nFROM\r\n  runs\r\nGROUP BY\r\n  timeBucket,\r\n  status\r\nORDER BY\r\n  timeBucket",
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
          "SELECT\r\n  task_identifier AS task,\r\n  count() AS runs,\r\n  countIf (status IN ('Failed', 'Crashed', 'System failure')) AS failures,\r\n  concat(round((countIf (status IN ('Failed', 'Crashed', 'System failure')) / count()) * 100, 2), '%') AS failure_rate,\r\n  avg(attempt_count - 1) AS avg_retries\r\nFROM\r\n  runs\r\nGROUP BY\r\n  task_identifier\r\nORDER BY\r\n  (countIf (status IN ('Failed', 'Crashed', 'System failure')) / count()) DESC;",
        display: { type: "table", prettyFormatting: true, sorting: [] },
      },
      IKB8cENo: {
        title: "Top failing tags",
        query:
          "SELECT\r\n  arrayJoin(tags) AS tag,\r\n  count() AS runs,\r\n  countIf (status IN ('Failed', 'Crashed', 'System failure')) AS failures,\r\n  concat(round((countIf (status IN ('Failed', 'Crashed', 'System failure')) / count()) * 100, 2), '%') AS failure_rate,\r\n  avg(attempt_count - 1) AS avg_retries\r\nFROM\r\n  runs\r\nGROUP BY\r\n  tag\r\nORDER BY\r\n  (countIf (status IN ('Failed', 'Crashed', 'System failure')) / count()) DESC;",
        display: { type: "table", prettyFormatting: true, sorting: [] },
      },
      "-fHz3CyQ": { title: "Usage and cost", query: "", display: { type: "title" } },
      hnKsN482: {
        title: "Cost by task",
        query:
          "SELECT\r\n  timeBucket() as time_period,\r\n  task_identifier,\r\n  sum(total_cost) AS total_cost\r\nFROM\r\n  runs\r\nGROUP BY\r\n  time_period,\r\n  task_identifier\r\nORDER BY\r\n  time_period",
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
          "SELECT\r\n  timeBucket () as time_period,\r\n  task_identifier,\r\n  count() AS run_count\r\nFROM\r\n  runs\r\nWHERE status IN ('Failed', 'Crashed', 'System failure')\r\nGROUP BY\r\n  time_period,\r\n  task_identifier\r\nORDER BY\r\n  time_period",
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
        title: "Run success %",
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
          aggregation: "avg",
          seriesColors: { failed: "#f43f5e" },
        },
      },
      Kh0w0fjy: {
        title: "Top errors",
        query:
          "SELECT\r\n  concat(error.name, '(\"', error.message, '\")') AS error,\r\n  count() AS count\r\nFROM\r\n  runs\r\nWHERE\r\n  runs.error != NULL\r\n  AND runs.error.name != NULL\r\nGROUP BY\r\n  error\r\nORDER BY\r\n  count DESC",
        display: { type: "table", prettyFormatting: true, sorting: [] },
      },
      zybRTAdz: {
        title: "Top errors over time",
        query:
          "SELECT\r\n  timeBucket(),\r\n  concat(error.name, '(\"', error.message, '\")') AS error,\r\n  count() AS count\r\nFROM\r\n  runs\r\nWHERE\r\n  runs.error != NULL\r\n  AND runs.error.name != NULL\r\nGROUP BY\r\n  timeBucket,\r\n  error\r\nORDER BY\r\n  count DESC",
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
          "SELECT\r\n  timeBucket() as time_period,\r\n  machine,\r\n  sum(total_cost) AS total_cost\r\nFROM\r\n  runs\r\nWHERE machine != ''\r\nGROUP BY\r\n  time_period,\r\n  machine\r\nORDER BY\r\n  time_period",
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
          aggregation: "avg",
          seriesColors: {},
        },
      },
      xyQl3FAd: {
        title: "Queued",
        query:
          "SELECT\r\n  count() AS queued\r\nFROM\r\n  runs\r\nWHERE status IN ('Dequeued', 'Queued')",
        display: { type: "bignumber", column: "queued", aggregation: "sum", abbreviate: false },
      },
    },
  },
};

const llmDashboard: BuiltInDashboard = {
  key: "llm",
  title: "AI metrics",
  filters: ["tasks", "models", "prompts", "operations", "providers"],
  layout: {
    version: "1",
    layout: [
      // Big numbers row
      { i: "llm-cost", x: 0, y: 0, w: 3, h: 4 },
      { i: "llm-calls", x: 3, y: 0, w: 3, h: 4 },
      { i: "llm-ttfc", x: 6, y: 0, w: 3, h: 4 },
      { i: "llm-tps", x: 9, y: 0, w: 3, h: 4 },
      // Cost section
      { i: "llm-title-cost", x: 0, y: 4, w: 12, h: 2, minH: 2, maxH: 2 },
      { i: "llm-cost-time", x: 0, y: 6, w: 6, h: 13 },
      { i: "llm-cost-model", x: 6, y: 6, w: 6, h: 13 },
      // Usage section
      { i: "llm-title-usage", x: 0, y: 19, w: 12, h: 2, minH: 2, maxH: 2 },
      { i: "llm-tokens-time", x: 0, y: 21, w: 6, h: 13 },
      { i: "llm-calls-model", x: 6, y: 21, w: 6, h: 13 },
      // Performance section
      { i: "llm-title-perf", x: 0, y: 34, w: 12, h: 2, minH: 2, maxH: 2 },
      { i: "llm-ttfc-time", x: 0, y: 36, w: 6, h: 13 },
      { i: "llm-tps-model", x: 6, y: 36, w: 6, h: 13 },
      { i: "llm-latency-pct", x: 0, y: 49, w: 6, h: 13 },
      { i: "llm-latency-time", x: 6, y: 49, w: 6, h: 13 },
      // Behavior section
      { i: "llm-title-behavior", x: 0, y: 62, w: 12, h: 2, minH: 2, maxH: 2 },
      { i: "llm-finish-reasons", x: 0, y: 64, w: 6, h: 13 },
      { i: "llm-top-runs", x: 6, y: 64, w: 6, h: 13 },
      // Attribution section
      { i: "llm-title-attribution", x: 0, y: 77, w: 12, h: 2, minH: 2, maxH: 2 },
      { i: "llm-cost-task", x: 0, y: 79, w: 6, h: 13 },
      { i: "llm-cost-provider", x: 6, y: 79, w: 6, h: 13 },
      { i: "llm-cost-prompt", x: 0, y: 92, w: 6, h: 13 },
      { i: "llm-cost-user", x: 6, y: 92, w: 6, h: 13 },
      // Efficiency section
      { i: "llm-title-efficiency", x: 0, y: 105, w: 12, h: 2, minH: 2, maxH: 2 },
      { i: "llm-cost-operation", x: 0, y: 107, w: 6, h: 13 },
      { i: "llm-cache-util", x: 6, y: 107, w: 6, h: 13 },
    ],
    widgets: {
      "llm-cost": {
        title: "Total LLM cost",
        query: "SELECT\r\n  SUM(total_cost) AS total_cost\r\nFROM\r\n  llm_metrics",
        display: {
          type: "bignumber",
          column: "total_cost",
          aggregation: "sum",
          abbreviate: true,
        },
      },
      "llm-calls": {
        title: "Total calls",
        query: "SELECT\r\n  count() AS total_calls\r\nFROM\r\n  llm_metrics",
        display: {
          type: "bignumber",
          column: "total_calls",
          aggregation: "sum",
          abbreviate: false,
        },
      },
      "llm-ttfc": {
        title: "Avg TTFC",
        query:
          "SELECT\r\n  round(avg(ms_to_first_chunk), 1) AS avg_ttfc\r\nFROM\r\n  llm_metrics\r\nWHERE ms_to_first_chunk > 0",
        display: {
          type: "bignumber",
          column: "avg_ttfc",
          aggregation: "avg",
          abbreviate: false,
          suffix: "ms",
        },
      },
      "llm-tps": {
        title: "Avg tokens/sec",
        query:
          "SELECT\r\n  round(avg(tokens_per_second), 1) AS avg_tps\r\nFROM\r\n  llm_metrics\r\nWHERE tokens_per_second > 0",
        display: {
          type: "bignumber",
          column: "avg_tps",
          aggregation: "avg",
          abbreviate: false,
          suffix: "/s",
        },
      },
      "llm-title-cost": { title: "Cost", query: "", display: { type: "title" } },
      "llm-cost-time": {
        title: "Cost over time",
        query:
          "SELECT\r\n  timeBucket(),\r\n  SUM(total_cost) AS total_cost\r\nFROM\r\n  llm_metrics\r\nGROUP BY\r\n  timeBucket\r\nORDER BY\r\n  timeBucket",
        display: {
          type: "chart",
          chartType: "line",
          xAxisColumn: "timebucket",
          yAxisColumns: ["total_cost"],
          groupByColumn: null,
          stacked: false,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "sum",
        },
      },
      "llm-cost-model": {
        title: "Cost by model",
        query:
          "SELECT\r\n  timeBucket(),\r\n  response_model,\r\n  SUM(total_cost) AS total_cost\r\nFROM\r\n  llm_metrics\r\nGROUP BY\r\n  timeBucket,\r\n  response_model\r\nORDER BY\r\n  timeBucket",
        display: {
          type: "chart",
          chartType: "bar",
          xAxisColumn: "timebucket",
          yAxisColumns: ["total_cost"],
          groupByColumn: "response_model",
          stacked: true,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "sum",
        },
      },
      "llm-title-usage": { title: "Usage", query: "", display: { type: "title" } },
      "llm-tokens-time": {
        title: "Tokens over time",
        query:
          "SELECT\r\n  timeBucket(),\r\n  SUM(input_tokens) AS input_tokens,\r\n  SUM(output_tokens) AS output_tokens\r\nFROM\r\n  llm_metrics\r\nGROUP BY\r\n  timeBucket\r\nORDER BY\r\n  timeBucket",
        display: {
          type: "chart",
          chartType: "bar",
          xAxisColumn: "timebucket",
          yAxisColumns: ["input_tokens", "output_tokens"],
          groupByColumn: null,
          stacked: true,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "sum",
        },
      },
      "llm-calls-model": {
        title: "Calls by model",
        query:
          "SELECT\r\n  response_model,\r\n  count() AS calls,\r\n  SUM(total_tokens) AS tokens,\r\n  SUM(total_cost) AS cost\r\nFROM\r\n  llm_metrics\r\nGROUP BY\r\n  response_model\r\nORDER BY\r\n  cost DESC",
        display: { type: "table", prettyFormatting: true, sorting: [] },
      },
      "llm-title-perf": { title: "Performance", query: "", display: { type: "title" } },
      "llm-ttfc-time": {
        title: "TTFC over time",
        query:
          "SELECT\r\n  timeBucket(),\r\n  round(avg(ms_to_first_chunk), 1) AS avg_ttfc\r\nFROM\r\n  llm_metrics\r\nWHERE ms_to_first_chunk > 0\r\nGROUP BY\r\n  timeBucket\r\nORDER BY\r\n  timeBucket",
        display: {
          type: "chart",
          chartType: "line",
          xAxisColumn: "timebucket",
          yAxisColumns: ["avg_ttfc"],
          groupByColumn: null,
          stacked: false,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "avg",
        },
      },
      "llm-tps-model": {
        title: "Tokens/sec by model",
        query:
          "SELECT\r\n  timeBucket(),\r\n  response_model,\r\n  round(avg(tokens_per_second), 1) AS avg_tps\r\nFROM\r\n  llm_metrics\r\nWHERE tokens_per_second > 0\r\nGROUP BY\r\n  timeBucket,\r\n  response_model\r\nORDER BY\r\n  timeBucket",
        display: {
          type: "chart",
          chartType: "line",
          xAxisColumn: "timebucket",
          yAxisColumns: ["avg_tps"],
          groupByColumn: "response_model",
          stacked: false,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "avg",
        },
      },
      "llm-latency-pct": {
        title: "Latency percentiles by model",
        query:
          "SELECT\r\n  response_model,\r\n  round(quantile(0.5)(ms_to_first_chunk), 1) AS p50,\r\n  round(quantile(0.9)(ms_to_first_chunk), 1) AS p90,\r\n  round(quantile(0.95)(ms_to_first_chunk), 1) AS p95,\r\n  round(quantile(0.99)(ms_to_first_chunk), 1) AS p99,\r\n  count() AS calls\r\nFROM\r\n  llm_metrics\r\nWHERE ms_to_first_chunk > 0\r\nGROUP BY\r\n  response_model\r\nORDER BY\r\n  p50 DESC",
        display: { type: "table", prettyFormatting: true, sorting: [] },
      },
      "llm-latency-time": {
        title: "Latency percentiles over time",
        query:
          "SELECT\r\n  timeBucket(),\r\n  round(quantile(0.5)(ms_to_first_chunk), 1) AS p50,\r\n  round(quantile(0.95)(ms_to_first_chunk), 1) AS p95\r\nFROM\r\n  llm_metrics\r\nWHERE ms_to_first_chunk > 0\r\nGROUP BY\r\n  timeBucket\r\nORDER BY\r\n  timeBucket",
        display: {
          type: "chart",
          chartType: "line",
          xAxisColumn: "timebucket",
          yAxisColumns: ["p50", "p95"],
          groupByColumn: null,
          stacked: false,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "avg",
          seriesColors: { p95: "#f43f5e" },
        },
      },
      "llm-title-behavior": { title: "Behavior", query: "", display: { type: "title" } },
      "llm-finish-reasons": {
        title: "Finish reasons over time",
        query:
          "SELECT\r\n  timeBucket(),\r\n  finish_reason,\r\n  count() AS calls\r\nFROM\r\n  llm_metrics\r\nWHERE finish_reason != ''\r\nGROUP BY\r\n  timeBucket,\r\n  finish_reason\r\nORDER BY\r\n  timeBucket",
        display: {
          type: "chart",
          chartType: "bar",
          xAxisColumn: "timebucket",
          yAxisColumns: ["calls"],
          groupByColumn: "finish_reason",
          stacked: true,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "sum",
        },
      },
      "llm-top-runs": {
        title: "Most expensive runs",
        query:
          "SELECT\r\n  run_id,\r\n  task_identifier,\r\n  SUM(total_cost) AS llm_cost,\r\n  SUM(total_tokens) AS tokens\r\nFROM\r\n  llm_metrics\r\nGROUP BY\r\n  run_id,\r\n  task_identifier\r\nORDER BY\r\n  llm_cost DESC\r\nLIMIT 50",
        display: { type: "table", prettyFormatting: true, sorting: [] },
      },
      "llm-title-attribution": { title: "Attribution", query: "", display: { type: "title" } },
      "llm-cost-task": {
        title: "Cost by task",
        query:
          "SELECT\r\n  task_identifier,\r\n  SUM(total_cost) AS cost,\r\n  SUM(total_tokens) AS tokens,\r\n  count() AS calls\r\nFROM\r\n  llm_metrics\r\nGROUP BY\r\n  task_identifier\r\nORDER BY\r\n  cost DESC",
        display: { type: "table", prettyFormatting: true, sorting: [] },
      },
      "llm-cost-provider": {
        title: "Cost by provider",
        query:
          "SELECT\r\n  timeBucket(),\r\n  gen_ai_system,\r\n  SUM(total_cost) AS total_cost\r\nFROM\r\n  llm_metrics\r\nGROUP BY\r\n  timeBucket,\r\n  gen_ai_system\r\nORDER BY\r\n  timeBucket",
        display: {
          type: "chart",
          chartType: "bar",
          xAxisColumn: "timebucket",
          yAxisColumns: ["total_cost"],
          groupByColumn: "gen_ai_system",
          stacked: true,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "sum",
        },
      },
      "llm-cost-prompt": {
        title: "Cost by prompt",
        query:
          "SELECT\r\n  prompt_slug,\r\n  SUM(total_cost) AS cost,\r\n  SUM(total_tokens) AS tokens,\r\n  count() AS calls\r\nFROM\r\n  llm_metrics\r\nWHERE prompt_slug != ''\r\nGROUP BY\r\n  prompt_slug\r\nORDER BY\r\n  cost DESC",
        display: { type: "table", prettyFormatting: true, sorting: [] },
      },
      "llm-cost-user": {
        title: "Cost by user",
        query:
          "SELECT\r\n  metadata['userId'] AS user_id,\r\n  SUM(total_cost) AS cost,\r\n  SUM(total_tokens) AS tokens,\r\n  count() AS calls\r\nFROM\r\n  llm_metrics\r\nWHERE metadata['userId'] != ''\r\nGROUP BY\r\n  user_id\r\nORDER BY\r\n  cost DESC\r\nLIMIT 20",
        display: { type: "table", prettyFormatting: true, sorting: [] },
      },
      "llm-title-efficiency": { title: "Efficiency", query: "", display: { type: "title" } },
      "llm-cost-operation": {
        title: "Cost by operation type",
        query:
          "SELECT\r\n  timeBucket(),\r\n  operation_id,\r\n  SUM(total_cost) AS total_cost\r\nFROM\r\n  llm_metrics\r\nWHERE operation_id != ''\r\nGROUP BY\r\n  timeBucket,\r\n  operation_id\r\nORDER BY\r\n  timeBucket",
        display: {
          type: "chart",
          chartType: "bar",
          xAxisColumn: "timebucket",
          yAxisColumns: ["total_cost"],
          groupByColumn: "operation_id",
          stacked: true,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "sum",
        },
      },
      "llm-cache-util": {
        title: "Cache utilization",
        query:
          "SELECT\r\n  timeBucket(),\r\n  round(countIf(cached_read_tokens > 0) * 100.0 / count(), 1) AS cache_hit_pct,\r\n  round(avg(cached_read_tokens), 0) AS avg_cached_tokens\r\nFROM\r\n  llm_metrics\r\nGROUP BY\r\n  timeBucket\r\nORDER BY\r\n  timeBucket",
        display: {
          type: "chart",
          chartType: "line",
          xAxisColumn: "timebucket",
          yAxisColumns: ["cache_hit_pct"],
          groupByColumn: null,
          stacked: false,
          sortByColumn: null,
          sortDirection: "asc",
          aggregation: "avg",
        },
      },
    },
  },
};

const builtInDashboards: BuiltInDashboard[] = [overviewDashboard, llmDashboard];

export function builtInDashboardList(): BuiltInDashboard[] {
  return builtInDashboards;
}

export function builtInDashboard(key: string): BuiltInDashboard {
  const dashboard = builtInDashboards.find((d) => d.key === key);
  if (!dashboard) {
    throw new Error(`No built-in dashboard "${key}"`);
  }

  return dashboard;
}
