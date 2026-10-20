import type * as RechartsModule from "recharts";
import { cloneElement, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AlertMultiSeriesChart,
  AlertThresholdChart,
  formatAlertTick,
  thresholdWarningOverlay,
  visibleSeriesKeys,
} from "./AlertThresholdChart";
import type { MetricSeriesPoint } from "./alertSeriesTypes";
import { evenTimeTicks, niceYAxis, stepDecimals, withRaiseTick } from "./alertAxis";
import { formatAlertValue } from "./formatAlertTick";
import { conditionSummary } from "./alertSummaries";
import { warningSwatchColor, warningSwatchThreshold } from "../primitives/charts/ChartLine";
import { EVENT_CHART_COLOR } from "./ActivityBars";
import { AlertMetricSparkline } from "./AlertMetricSparkline";

vi.mock("recharts", async (importOriginal) => {
  const actual = await importOriginal<typeof RechartsModule>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactNode }) =>
      isValidElement(children)
        ? cloneElement(children as React.ReactElement<any>, { width: 600, height: 200 })
        : null,
  };
});

const points: MetricSeriesPoint[] = [
  { bucket: 1000, value: 10 },
  { bucket: 2000, value: 20 },
];

const seriesMap = new Map<string, MetricSeriesPoint[]>([
  ["__agg__", points],
  ["worker-1", points],
  ["worker-2", points],
]);

describe("AlertMultiSeriesChart hostile queue names", () => {
  const hostile = ["a</style><script>alert(1)</script>", 'q"}{x:y', "ok-queue"];

  it("keeps raw names out of the style block and still shows them as text", () => {
    const map = new Map<string, MetricSeriesPoint[]>(hostile.map((k) => [k, points]));
    const html = renderToStaticMarkup(
      createElement(AlertMultiSeriesChart, {
        seriesMap: map,
        threshold: null,
        height: 96,
        showLegend: true,
      })
    );
    const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("");
    expect(html).not.toContain("<script>");
    expect(styles).not.toContain("alert(1)");
    expect(styles).not.toContain('q"}{x:y');
    expect(styles).toContain("--color-ok-queue");
    expect(html).toContain("a&lt;/style&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("AlertMultiSeriesChart", () => {
  it("renders no legend markup when showLegend is false", () => {
    const html = renderToStaticMarkup(
      createElement(AlertMultiSeriesChart, {
        seriesMap,
        threshold: null,
        height: 96,
        showLegend: false,
      })
    );
    expect(html).not.toContain("Total");
  });

  it("renders legend without Total row when showLegend is true", () => {
    const html = renderToStaticMarkup(
      createElement(AlertMultiSeriesChart, {
        seriesMap,
        threshold: null,
        height: 96,
        showLegend: true,
      })
    );
    expect(html).not.toContain("Total");
    expect(html).toContain("worker-1");
    expect(html).toContain("worker-2");
  });

  it("excludes __agg__ but includes __other__ labelled as Other", () => {
    const map = new Map<string, MetricSeriesPoint[]>([
      ["__agg__", points],
      ["__other__", points],
      ["queue-a", points],
      ["queue-b", points],
    ]);
    const keys = visibleSeriesKeys(map);
    expect(keys).toContain("queue-a");
    expect(keys).toContain("queue-b");
    expect(keys).toContain("__other__");
    expect(keys).not.toContain("__agg__");
  });

  it("renders __other__ with label Other in the legend", () => {
    const map = new Map<string, MetricSeriesPoint[]>([
      ["__agg__", points],
      ["__other__", points],
      ["queue-a", points],
      ["queue-b", points],
    ]);
    const html = renderToStaticMarkup(
      createElement(AlertMultiSeriesChart, {
        seriesMap: map,
        threshold: null,
        height: 96,
        showLegend: true,
      })
    );
    expect(html).toContain(">Other<");
    expect(html).not.toContain(">__other__<");
    expect(html).not.toContain(">__agg__<");
  });
});

describe("empty states", () => {
  it("fails when the empty state is not the shared chart placeholder", () => {
    const html = renderToStaticMarkup(
      createElement(AlertThresholdChart, { series: [], threshold: 5, fill: true })
    );
    expect(html).toContain("There&#x27;s no data available for the filters you&#x27;ve set.");
    expect(html).toContain("grid h-full place-items-center");
    expect(html).not.toContain("No readings");
  });

  it("renders empty state for empty series", () => {
    const html = renderToStaticMarkup(
      createElement(AlertThresholdChart, { series: [], threshold: 5, height: 96 })
    );
    expect(html).toContain("No data");
    expect(html).not.toContain("recharts-line");
  });

  it("renders empty state for all-null series", () => {
    const html = renderToStaticMarkup(
      createElement(AlertThresholdChart, {
        series: [{ bucket: 1, value: null as unknown as number }],
        threshold: null,
        height: 96,
      })
    );
    expect(html).toContain("No data");
  });

  it("renders empty state for empty multi-series map", () => {
    const html = renderToStaticMarkup(
      createElement(AlertMultiSeriesChart, {
        seriesMap: new Map(),
        threshold: null,
        height: 96,
      })
    );
    expect(html).toContain("No data");
  });
});

describe("threshold overlay direction", () => {
  it("maps < to below and > to above", () => {
    expect(thresholdWarningOverlay(10, "<")?.direction).toBe("below");
    expect(thresholdWarningOverlay(10, ">")?.direction).toBe("above");
    expect(thresholdWarningOverlay(10)?.direction).toBe("above");
    expect(thresholdWarningOverlay(null, "<")).toBeUndefined();
  });

  it("colours the swatch below the threshold for <", () => {
    expect(warningSwatchColor(5, 10, undefined, "below")).toBe("var(--color-warning)");
    expect(warningSwatchColor(50, 10, undefined, "below")).toBeUndefined();
  });
});

describe("chart states", () => {
  it("plots an all-zero series", () => {
    const html = renderToStaticMarkup(
      createElement(AlertThresholdChart, {
        series: [
          { bucket: 1000, value: 0 },
          { bucket: 2000, value: 0 },
        ],
        threshold: null,
        height: 96,
      })
    );
    expect(html).not.toContain("No data");
  });

  it("renders empty state when every multi-series key is empty", () => {
    const html = renderToStaticMarkup(
      createElement(AlertMultiSeriesChart, {
        seriesMap: new Map<string, MetricSeriesPoint[]>([
          ["a", []],
          ["b", []],
        ]),
        threshold: null,
        height: 96,
      })
    );
    expect(html).toContain("No data");
  });
});

describe("formatAlertTick", () => {
  it("humanizes by unit", () => {
    expect(formatAlertTick(30000, "ms")).toBe("30s");
    expect(formatAlertTick(90000, "ms")).toBe("1.5m");
    expect(formatAlertTick(10, "percent")).toBe("10%");
    expect(formatAlertTick(99.5, "percent")).toBe("99.5%");
    expect(formatAlertTick(1200, "")).toBe("1.2K");
    expect(formatAlertTick(300, "seconds")).toBe("5m");
    expect(formatAlertTick(45, "seconds")).toBe("45s");
    expect(formatAlertTick(3, "runs")).toBe("3 runs");
  });
});

describe("axis helpers", () => {
  it("nice ticks are round and include the threshold", () => {
    const { ticks, domain } = niceYAxis(210, 100);
    expect(ticks).toContain(100);
    expect(ticks).toEqual([0, 50, 100, 150, 200, 250]);
    expect(domain).toEqual([0, 250]);
  });

  it("adds an off-grid threshold as a tick", () => {
    const { ticks } = niceYAxis(200, 130);
    expect(ticks).toContain(130);
  });

  it("uses one duration unit for the whole axis", () => {
    const labels = [0, 15000, 30000].map((v) => formatAlertTick(v, "ms", 30000));
    expect(labels).toEqual(["0s", "15s", "30s"]);
  });

  it("gives 5-7 evenly spaced x ticks for 48 buckets", () => {
    const buckets = Array.from({ length: 48 }, (_, i) => 1_000_000 + i * 300_000);
    const ticks = evenTimeTicks(buckets);
    expect(ticks.length).toBeGreaterThanOrEqual(5);
    expect(ticks.length).toBeLessThanOrEqual(7);
    const gaps = new Set(ticks.slice(1).map((t, i) => t - ticks[i]!));
    expect(gaps.size).toBe(1);
  });
});

describe("AlertMetricSparkline", () => {
  it("labels the peak with its unit", () => {
    const html = renderToStaticMarkup(
      createElement(AlertMetricSparkline, {
        series: [
          { bucket: 1, value: 900 },
          { bucket: 2, value: 1800 },
        ],
        valueUnit: "ms",
      })
    );
    expect(html).toContain("1.8s");
  });
});

describe("display-unit axis", () => {
  const labels = (max: number, threshold: number | null, unit: string) => {
    const { ticks, domain, step } = niceYAxis(max, threshold, unit);
    const d = stepDecimals(step);
    return ticks.map((t) => formatAlertTick(t, unit, domain[1], d));
  };

  it("uses 15s steps up to a minute", () => {
    expect(labels(63000, null, "ms").slice(0, 5)).toEqual(["0s", "15s", "30s", "45s", "1m"]);
  });

  it("uses clean sub-second labels", () => {
    expect(labels(1050, null, "ms")).toEqual(["0s", "0.25s", "0.5s", "0.75s", "1s", "1.25s"]);
  });

  it("keeps the top tick above the data for an off-grid threshold", () => {
    const { ticks, domain } = niceYAxis(140, 130);
    expect(ticks).toContain(130);
    expect(domain[1]).toBeGreaterThanOrEqual(140 * 1.05);
  });

  it("does not duplicate small percent labels", () => {
    const l = labels(0.2, null, "percent");
    expect(new Set(l).size).toBe(l.length);
  });

  it("fails when the first bucket has no x tick", () => {
    const buckets = Array.from({ length: 42 }, (_, i) => i * 1_800_000);
    const ticks = evenTimeTicks(buckets);
    expect(ticks[0]).toBe(buckets[0]);
    expect(ticks.length).toBeLessThanOrEqual(7);
  });

  it("fails when the raise tick overlaps the first tick", () => {
    const buckets = Array.from({ length: 42 }, (_, i) => i * 1_800_000);
    const ticks = withRaiseTick(evenTimeTicks(buckets), buckets[1]);
    expect(ticks[0]).toBe(buckets[1]);
    expect(ticks).not.toContain(buckets[0]);
  });

  it("shows every tick for up to 8 buckets", () => {
    const buckets = Array.from({ length: 8 }, (_, i) => i * 60000);
    expect(evenTimeTicks(buckets)).toHaveLength(8);
  });
});

describe("exact condition values", () => {
  it("keeps precision in summaries", () => {
    expect(formatAlertValue(1250, "duration_ms")).toBe("1.25s");
    expect(formatAlertValue(1234, "count")).toBe("1,234");
    expect(
      conditionSummary(
        { kind: "threshold", operator: ">", value: 1250, windowSec: 300 } as any,
        "duration_ms"
      )
    ).toBe("> 1.25s over 5m");
  });
});

describe("tooltip swatch", () => {
  it("is opt-in and follows the threshold", () => {
    expect(warningSwatchThreshold({ threshold: 60 })).toBeUndefined();
    expect(warningSwatchThreshold({ threshold: 60, tooltipSwatch: true })).toBe(60);
    expect(warningSwatchColor(70, 60)).toBe("var(--color-warning)");
    expect(warningSwatchColor(50, 60)).toBeUndefined();
    expect(warningSwatchColor(70, undefined)).toBeUndefined();
  });
});

describe("chart colour", () => {
  it("uses the shared alert chart colour, not the queues css var", () => {
    const html = renderToStaticMarkup(
      createElement(AlertThresholdChart, { series: points, threshold: null, height: 96 })
    );
    expect(html).toContain(EVENT_CHART_COLOR);
    expect(html).not.toContain("--color-queues-chart");
  });
});

describe("AlertThresholdChart single reading", () => {
  it("fails when a lone reading is drawn as a dot", () => {
    const html = renderToStaticMarkup(
      createElement(AlertThresholdChart, {
        series: [
          { bucket: 1000, value: null },
          { bucket: 2000, value: 60 },
          { bucket: 3000, value: null },
        ],
        threshold: 200,
        height: 96,
      })
    );
    expect(html).toContain("No data");
    expect(html).not.toContain("recharts-line");
  });
});
