// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChartConfiguration } from "../metrics/QueryWidget";
import { QueryResultsChart } from "./QueryResultsChart";

const hostileNames = [
  "</style><script>alert(1)</script>",
  'series" onload="alert(1)',
  "series; } body { color: red; } /*",
  "series], body [data-chart",
  "url(https://example.com)",
  "__proto__",
  "constructor",
];

describe("query chart series rendering", () => {
  it.each(["bar", "line"] as const)(
    "preserves grouped %s labels without using them in CSS",
    (chartType) => {
      const config: ChartConfiguration = {
        chartType,
        xAxisColumn: "bucket",
        yAxisColumns: ["count"],
        groupByColumn: "group",
        stacked: false,
        sortByColumn: null,
        sortDirection: "asc",
        aggregation: "sum",
        seriesColors: Object.fromEntries(hostileNames.map((name) => [name, name])),
      };
      const container = document.createElement("div");
      container.innerHTML = renderToStaticMarkup(
        createElement(QueryResultsChart, {
          rows: hostileNames.map((group) => ({ bucket: "category", group, count: 1 })),
          columns: [],
          config,
          fullLegend: true,
        })
      );
      const style = container.querySelector("style")!;

      for (const name of hostileNames) {
        expect(container.textContent).toContain(name);
        expect(style.textContent).not.toContain(name);
      }
      expect(container.querySelectorAll("style")).toHaveLength(1);
      expect(container.querySelector("script, [onload]")).toBeNull();
    }
  );

  it.each([false, true])(
    "aggregates hostile names with numeric values (grouped: %s)",
    (grouped) => {
      const name = 'series.[0]</style>"{}';
      const config: ChartConfiguration = {
        chartType: "bar",
        xAxisColumn: "bucket",
        yAxisColumns: grouped ? ["count"] : [name],
        groupByColumn: grouped ? "group" : null,
        stacked: false,
        sortByColumn: null,
        sortDirection: "asc",
        aggregation: "sum",
        seriesColors: { [name]: "url(https://example.com)" },
      };
      const container = document.createElement("div");
      container.innerHTML = renderToStaticMarkup(
        createElement(QueryResultsChart, {
          rows: grouped
            ? [{ bucket: "category", group: name, count: 7 }]
            : [{ bucket: "category", [name]: 7 }],
          columns: [],
          config,
          fullLegend: true,
        })
      );

      expect(container.querySelector("style")?.textContent).not.toContain(name);
      expect(container.querySelector("script, [onload]")).toBeNull();
      container.querySelector("style")?.remove();
      expect(container.textContent).toContain(name);
      expect(container.textContent).toContain("7");
    }
  );
});
