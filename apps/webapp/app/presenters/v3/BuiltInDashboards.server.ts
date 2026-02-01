import { type BuiltInDashboard } from "./MetricDashboardPresenter.server";
import { z } from "zod";

const overviewDashboard: BuiltInDashboard = {
  key: "overview",
  title: "Overview",
  layout: {
    version: "1",
    layout: [
      { i: "a", x: 0, y: 0, w: 6, h: 20 },
      { i: "b", x: 6, y: 0, w: 6, h: 20 },
      { i: "c", x: 0, y: 20, w: 12, h: 20 },
    ],
    widgets: {
      a: {
        title: "Runs by status",
        query: `SELECT
                  toStartOfHour(triggered_at) AS HOUR,
                  status,
                  count() AS run_count
                FROM
                  runs
                GROUP BY
                  HOUR,
                  status
                ORDER BY
                  HOUR DESC
                LIMIT
                  100`,
        display: {
          type: "table",
          prettyFormatting: true,
          sorting: [],
        },
      },
      b: {
        title: "Runs by status",
        query: `SELECT
                  toStartOfHour(triggered_at) AS HOUR,
                  status,
                  count() AS run_count
                FROM
                  runs
                GROUP BY
                  HOUR,
                  status
                ORDER BY
                  HOUR DESC
                LIMIT
                  100`,
        display: {
          type: "chart",
          chartType: "bar",
          xAxisColumn: "HOUR",
          yAxisColumns: ["run_count"],
          groupByColumn: "status",
          stacked: true,
          aggregation: "sum",
          sortDirection: "asc",
          sortByColumn: "HOUR",
        },
      },
      c: {
        title: "Runs by status",
        query: `SELECT
                  toStartOfHour(triggered_at) AS HOUR,
                  status,
                  count() AS run_count
                FROM
                  runs
                GROUP BY
                  HOUR,
                  status
                ORDER BY
                  HOUR DESC
                LIMIT
                  100`,
        display: {
          type: "table",
          prettyFormatting: true,
          sorting: [],
        },
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
