// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChartContainer, type ChartConfig } from "./Chart";

describe("chart stylesheet rendering", () => {
  it.each([
    "</style><script>alert(1)</script>",
    'series" onload="alert(1)',
    "series; } body { color: red; } /*",
    "series], body [data-chart",
    "url(https://example.com)",
  ])("keeps configuration key %s out of CSS and selector attributes", (key) => {
    const config: ChartConfig = {
      [key]: { label: key, color: "#123456" },
      invalidColor: { color: key },
      themed: { theme: { light: "#abc", dark: key } },
    };
    const html = renderToStaticMarkup(
      createElement(ChartContainer, {
        id: key,
        config,
        // oxlint-disable-next-line react/no-children-prop -- Required by ChartContainer's createElement props type.
        children: createElement("div"),
      })
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    const chart = container.querySelector("[data-chart]")!;
    const chartId = chart.getAttribute("data-chart")!;
    const style = chart.querySelector("style")!;

    expect(chartId).toMatch(/^chart-[a-f0-9-]+$/);
    expect(chart.id).toBe(key);
    expect(style.childNodes).toHaveLength(1);
    expect(style.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(style.textContent).toContain(`[data-chart=${chartId}]`);
    expect(style.textContent).toContain("--color-series-0: #123456;");
    expect(style.textContent).toContain("--color-series-1: var(--color-text-dimmed);");
    expect(style.textContent).toContain(":is([data-theme=dark], [data-theme=black])");
    expect(style.textContent).not.toContain(key);
    expect(style.textContent).not.toContain("&quot;");
    expect(container.querySelectorAll("style")).toHaveLength(1);
    expect(container.querySelector("script, [onload]")).toBeNull();
  });
});
