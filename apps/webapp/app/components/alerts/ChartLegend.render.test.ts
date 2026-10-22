import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ABSENCE_SERIES,
  absenceLegend,
  HEALTH_CONFIG,
  HEALTH_LEGEND,
  HEALTH_WARNING_OVERLAY,
  quietReferenceAreas,
} from "./AlertDetailCharts";
import { healthLegend } from "./AlertDetailChart";
import {
  HEALTH_LINE_COLORS,
  HEALTH_QUERIES_WARNING_OVERLAY,
  healthQueriesLegend,
} from "./AlertHealthQueriesChart";
import { thresholdChartLegend, thresholdChartParts } from "./AlertThresholdChart";
import {
  ChartLegend,
  RAISED_MARKER_COLOR,
  THRESHOLD_LINE_COLOR,
  WARNING_COLOR,
  type ChartLegendItem,
} from "./ChartLegend";

const exempt = (items: { color?: string }[]) =>
  items.filter((i) => i.color !== THRESHOLD_LINE_COLOR && i.color !== RAISED_MARKER_COLOR);

const colors = (items: { color?: string }[]) => [...new Set(items.map((i) => i.color))].sort();

describe("ChartLegend", () => {
  it("renders a labelled swatch per item", () => {
    const items: ChartLegendItem[] = [
      { swatch: "line", color: "#111111", label: "Reading" },
      { swatch: "dashed", color: "#222222", label: "Threshold" },
      { swatch: "area", color: "#333333", label: "Quiet" },
      { swatch: "marker", color: "#444444", label: "Raised" },
    ];
    const html = renderToStaticMarkup(createElement(ChartLegend, { items }));
    for (const item of items) {
      expect(html).toContain(item.label);
      expect(html).toContain(item.color);
    }
    expect(html).toContain("border-dashed");
  });

  it("renders nothing for no items", () => {
    expect(renderToStaticMarkup(createElement(ChartLegend, { items: [] }))).toBe("");
  });
});

describe("legend covers every colour the chart draws", () => {
  it("health chart", () => {
    const drawn = [
      ...Object.values(HEALTH_CONFIG).map((c) => ({ color: c.color })),
      HEALTH_WARNING_OVERLAY,
    ];
    expect(colors(HEALTH_LEGEND)).toEqual(colors(drawn));
  });

  it("health queries chart", () => {
    const series = [
      { key: "a", label: "A", points: [] },
      { key: "b", label: "B", points: [] },
    ];
    const drawn = [
      { color: HEALTH_LINE_COLORS[0] },
      { color: HEALTH_LINE_COLORS[1] },
      HEALTH_QUERIES_WARNING_OVERLAY,
      { color: THRESHOLD_LINE_COLOR },
    ];
    expect(colors(healthQueriesLegend(series as any))).toEqual(colors(exempt(drawn)));
  });

  it("health legend has no Raised item in either view", () => {
    const series = [{ key: "a", label: "A", points: [] }] as any;
    for (const separate of [false, true]) {
      const labels = healthLegend(separate, series).map((i) => i.label);
      expect(labels).not.toContain("Raised");
      expect(labels).not.toContain("Threshold");
    }
  });

  it("absence chart", () => {
    const run = (bucket: number, value: number) => ({ bucket, value });
    const data = [run(0, 1), run(60_000, 0), run(120_000, 0), run(180_000, 0)];
    const areas = quietReferenceAreas(data, 120);
    expect(areas.length).toBeGreaterThan(0);
    const drawn = [
      ...ABSENCE_SERIES,
      ...areas.flatMap((a) => [{ color: a.fill }, { color: a.stroke }]),
    ];
    expect(colors(absenceLegend(data, 120))).toEqual(colors(drawn));
  });

  it.each([
    [">", "Above threshold"],
    ["<", "Below threshold"],
  ] as const)("single-series threshold chart (%s)", (operator, warningLabel) => {
    const input = { label: "Depth", threshold: 5, operator };
    const parts = thresholdChartParts(input);
    const drawn = [
      ...Object.values(parts.config),
      parts.overlay,
      { color: parts.referenceLineColor },
    ];
    const legend = thresholdChartLegend(input);
    expect(colors(legend)).toEqual(colors(exempt(drawn as { color?: string }[])));
    expect(legend.map((i) => i.label)).toEqual(["Depth", warningLabel]);
    expect(parts.overlay!.color).toBe(WARNING_COLOR);
  });

  it("multi-series threshold chart draws no warning overlay and lists no warning item", () => {
    const pts = [{ bucket: 1, value: 1 }];
    const seriesMap = new Map([
      ["a", pts],
      ["b", pts],
      ["__other__", pts],
    ]);
    const input = { seriesMap, label: "Depth", threshold: 5, operator: ">" as const };
    const parts = thresholdChartParts(input);
    expect(parts.overlay).toBeUndefined();
    const drawn = [...Object.values(parts.config)];
    const legend = thresholdChartLegend(input);
    expect(colors(legend)).toEqual(colors(drawn));
    expect(legend.map((i) => i.label)).toEqual(["a", "b", "Other"]);
  });
});
