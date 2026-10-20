import type * as RechartsModule from "recharts";
import { cloneElement, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ChartProvider } from "~/components/primitives/charts/ChartContext";
import { ChartBarRenderer } from "~/components/primitives/charts/ChartBar";
import {
  AbsenceActivityChart,
  absenceLegend,
  quietReferenceAreas,
  HEALTH_LEGEND,
  healthPoints,
  healthTooltipLabel,
  HealthActivityChart,
} from "./AlertDetailCharts";
import { EVENT_CHART_COLOR } from "./ActivityBars";
import { AlertMultiSeriesChart, AlertThresholdChart } from "./AlertThresholdChart";
import {
  buildHealthBands,
  healthEventsForBands,
  quietWindowBounds,
  type HealthBandRow,
  type MetricSeriesPoint,
} from "./alertSeriesTypes";

// ResponsiveContainer measures the DOM, so static markup would draw no plot at all.
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

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

const bands: HealthBandRow[] = [
  { bucket: T0, degraded: null, healthy: 1, unknown: null },
  { bucket: T0 + 4 * HOUR, degraded: 1, healthy: null, unknown: null },
  { bucket: T0 + 8 * HOUR, degraded: null, healthy: null, unknown: 1 },
];

const runsUntil = (lastRunIndex: number): MetricSeriesPoint[] =>
  Array.from({ length: 12 }, (_, i) => ({
    bucket: T0 + i * 5 * 60 * 1000,
    value: i <= lastRunIndex ? 3 : 0,
  }));

describe("HealthActivityChart", () => {
  it("draws a step line with a Healthy legend", () => {
    expect(HEALTH_LEGEND.map((l) => l.label)).toEqual(["Healthy", "Degraded"]);
    expect(HEALTH_LEGEND[0]!.color).toBe(EVENT_CHART_COLOR);

    const html = renderToStaticMarkup(
      createElement(HealthActivityChart, { bands: bands.slice(0, 2) })
    );
    expect(html).toContain("recharts-line-curve");
    const pathD = (stroke: string) =>
      html.match(new RegExp(`stroke="${stroke}"[^>]*recharts-line-curve" d="([^"]*)"`))?.[1];
    const pts = (d: string) =>
      [...d.matchAll(/([\d.]+),([\d.]+)/g)].map((m) => m.slice(1, 3).map(Number));
    const base = pts(pathD(EVENT_CHART_COLOR)!);
    const warn = pts(pathD("var\\(--color-warning\\)")!);
    const [x0, y0] = base[0]!;
    const [x1, y1] = base[base.length - 1]!;
    const [x3, y3] = warn[warn.length - 1]!;
    expect(y1).toBe(y0);
    expect(x1).toBeCloseTo((x0! + x3!) / 2);
    expect(warn[0]).toEqual([x1, y1]);
    const drop = warn.find(([, y]) => y !== y1)!;
    expect(drop[0]).toBe(x1);
    expect(drop[1]).toBeGreaterThan(y1!);
    expect(y3).toBe(drop[1]);
    expect(html.match(/>Healthy</g)).toHaveLength(1);
    expect(html).not.toContain(">Degraded<");
    expect(html).toContain(`stroke="${EVENT_CHART_COLOR}"`);
  });

  it("paints the degraded segment in the warning colour over a gapped base line", () => {
    const three: HealthBandRow[] = [
      { bucket: T0, degraded: null, healthy: 1, unknown: null },
      { bucket: T0 + 4 * HOUR, degraded: null, healthy: 1, unknown: null },
      { bucket: T0 + 8 * HOUR, degraded: 1, healthy: null, unknown: null },
    ];
    const html = renderToStaticMarkup(createElement(HealthActivityChart, { bands: three }));
    const pathD = (stroke: string) =>
      html.match(new RegExp(`stroke="${stroke}"[^>]*recharts-line-curve" d="([^"]*)"`))?.[1];
    const base = pathD(EVENT_CHART_COLOR)!;
    const warn = pathD("var\\(--color-warning\\)")!;
    expect(base).toBeDefined();
    expect(warn).toBeDefined();
    const xs = (d: string) => [...d.matchAll(/[ML]([\d.]+),/g)].map((m) => Number(m[1]));
    const baseEnd = xs(base)[xs(base).length - 1]!;
    expect(xs(warn)[0]).toBe(baseEnd);
    expect(xs(warn)[xs(warn).length - 1]).toBeGreaterThan(baseEnd);
  });

  it("labels the trailing point Now only when the current state is known", () => {
    const timeLabel = (_: string, payload: any[]) => `t${payload[0].payload.bucket}`;
    const trailing = [{ payload: { bucket: 20 } }];
    expect(healthTooltipLabel(timeLabel, 10, 1)("", trailing)).toBe("Now");
    expect(healthTooltipLabel(timeLabel, 10, undefined)("", trailing)).toBe("t10");
    expect(healthTooltipLabel(timeLabel, 10, 1)("", [{ payload: { bucket: 10 } }])).toBe("t10");
  });

  it("maps healthy to 1, degraded to 0 and unknown to a gap", () => {
    expect(healthPoints(bands).map((p) => p.health)).toEqual([1, 0, null, null]);
  });

  it("fails when the trailing point repeats a degraded bucket after recovery", () => {
    const until = Date.parse("2026-10-01T11:56:00Z");
    const seeded = buildHealthBands(
      healthEventsForBands([
        { type: "recovered", at: new Date("2026-10-01T11:30:05.408Z"), facts: { value: 0 } },
        { type: "raised", at: new Date("2026-10-01T09:52:44.654Z"), facts: {} },
      ]),
      until,
      until - 7 * 24 * HOUR
    );
    const points = healthPoints(seeded, 1);
    expect(points[points.length - 2]!.health).toBe(0);
    expect(points[points.length - 1]!.health).toBe(1);
  });

  it("draws a flat segment for a single band", () => {
    const html = renderToStaticMarkup(
      createElement(HealthActivityChart, { bands: bands.slice(0, 1) })
    );
    const m = html.match(/ d="M([\d.]+),([\d.]+)L([\d.]+),([\d.]+)/);
    const [x0, y0, x1, y1] = m!.slice(1).map(Number) as number[];
    expect(x1).toBeGreaterThan(x0!);
    expect(y1).toBe(y0);
  });

  it("labels the raise bucket on the x axis", () => {
    const html = renderToStaticMarkup(
      createElement(HealthActivityChart, { bands, raisedAt: new Date(T0 + 5 * HOUR) })
    );
    expect(html).toContain("▲ raised");
  });
});

describe("AbsenceActivityChart", () => {
  const STEP = 5 * 60 * 1000;
  const bars = (html: string) => html.match(/recharts-bar-rectangle"><path/g)?.length ?? 0;
  const areas = (html: string) => html.match(/recharts-reference-area(?!-)/g)?.length ?? 0;
  const pattern = (values: number[]): MetricSeriesPoint[] =>
    values.map((value, i) => ({ bucket: T0 + i * STEP, value }));
  const chart = (series: MetricSeriesPoint[], trailing?: { since: Date; now: Date }): string =>
    renderToStaticMarkup(
      createElement(AbsenceActivityChart, { series, quietWindowSec: 1800, trailing })
    );

  it("bands the trailing empty run once it reaches the window", () => {
    const series = runsUntil(4);
    const quietWindow = quietWindowBounds(series, 1800);
    const html = renderToStaticMarkup(createElement(AbsenceActivityChart, { series, quietWindow }));
    expect(areas(html)).toBe(1);
    expect(html).toContain('fill="var(--color-warning)"');
    expect(quietReferenceAreas(series, 1800)).toMatchObject([
      { x1: series[5]!.bucket, x2: series[11]!.bucket },
    ]);
    expect(bars(html)).toBe(5);
  });

  it("draws no band while runs arrive inside the window", () => {
    const series = runsUntil(9);
    expect(quietReferenceAreas(series, 1800)).toEqual([]);
    expect(absenceLegend(series, 1800).map((l) => l.label)).toEqual(["Runs created"]);
  });

  it("draws one band per separate empty run of the window or longer", () => {
    const series = pattern([3, 0, 0, 0, 0, 0, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 3, 3, 3]);
    expect(quietReferenceAreas(series, 1800)).toMatchObject([
      { x1: series[1]!.bucket, x2: series[6]!.bucket },
      { x1: series[9]!.bucket, x2: series[15]!.bucket },
    ]);
    expect(areas(chart(series))).toBe(2);
  });

  it("skips an empty run shorter than the window", () => {
    const series = pattern([3, 0, 0, 3, 3, 3]);
    expect(quietReferenceAreas(series, 1800)).toEqual([]);
  });

  it("bands the open current bucket when the series stops at the last reading", () => {
    const series: MetricSeriesPoint[] = Array.from({ length: 4 }, (_, i) => ({
      bucket: T0 + i * HOUR,
      value: 2,
    }));
    const trailing = {
      since: new Date(T0 + 3 * HOUR + 20 * 60_000),
      now: new Date(T0 + 4 * HOUR + 50 * 60_000),
    };
    expect(quietReferenceAreas(series, 1800, trailing)).toMatchObject([
      { x1: T0 + 4 * HOUR, x2: T0 + 4 * HOUR },
    ]);
    expect(areas(chart(series, trailing))).toBe(1);
  });

  it("ends the trailing band at the last bucket and starts after the last reading", () => {
    const series = pattern([3, 3, 3, 3, 3, 3, 0, 0, 0, 0, 0, 0]);
    const trailing = {
      since: new Date(T0 + 5 * STEP + 2 * 60_000),
      now: new Date(T0 + 12 * STEP),
    };
    expect(quietReferenceAreas(series, 1800, trailing)).toMatchObject([
      { x1: series[6]!.bucket, x2: T0 + 12 * STEP },
    ]);
    expect(bars(chart(series, trailing))).toBe(6);
  });

  it("starts the trailing band after later readings even when since precedes them", () => {
    const series = pattern([3, 3, 3, 3, 3, 3, 3, 3, 0, 0, 0, 0]);
    const trailing = { since: new Date(T0 - HOUR), now: new Date(T0 + 12 * STEP) };
    expect(quietReferenceAreas(series, 1800, trailing)).toMatchObject([
      { x1: series[8]!.bucket, x2: T0 + 12 * STEP },
    ]);
  });

  it("keeps the band when it covers every bucket", () => {
    const series = pattern(new Array(12).fill(0));
    const trailing = { since: new Date(T0 - HOUR), now: new Date(T0 + 12 * STEP) };
    expect(areas(chart(series, trailing))).toBe(1);
  });

  it("labels the legend Quiet without minutes", () => {
    const hourly: MetricSeriesPoint[] = Array.from({ length: 24 }, (_, i) => ({
      bucket: T0 + i * HOUR,
      value: i < 22 ? 2 : 0,
    }));
    const now = T0 + 24 * HOUR;
    const trailing = { since: new Date(now - 163 * 60_000), now: new Date(now) };
    const labels = absenceLegend(hourly, 1800, trailing).map((l) => l.label);
    expect(labels).toEqual(["Runs created", "Quiet"]);
    expect(labels.join("")).not.toMatch(/\d/);
  });

  it("bands a raised absence whose series ends in the last reading bucket", () => {
    const hourly: MetricSeriesPoint[] = Array.from({ length: 8 }, (_, i) => ({
      bucket: T0 + i * HOUR,
      value: 2,
    }));
    const trailing = {
      since: new Date(T0 + 7 * HOUR + 20 * 60_000),
      now: new Date(T0 + 9 * HOUR - 6 * 60_000),
    };
    expect(quietReferenceAreas(hourly, 1800, trailing)).not.toEqual([]);
    expect(absenceLegend(hourly, 1800, trailing).map((l) => l.label)).toContain("Quiet");
  });

  it("draws no band for an empty series", () => {
    expect(quietReferenceAreas([], 1800)).toEqual([]);
    expect(absenceLegend([], 1800).map((l) => l.label)).toEqual(["Runs created"]);
  });
});

describe("Chart.Bar referenceArea", () => {
  const data = [
    { bucket: 1, value: 1 },
    { bucket: 2, value: 2 },
    { bucket: 3, value: 3 },
  ];

  function renderBar(referenceArea?: { x1: number; x2: number; fill: string }) {
    return renderToStaticMarkup(
      createElement(
        ChartProvider,
        { config: { value: { label: "V", color: "#000" } }, data, dataKey: "bucket" },
        createElement(ChartBarRenderer, { width: 400, height: 200, referenceArea })
      )
    );
  }

  it("renders the area only when given", () => {
    expect(renderBar({ x1: 2, x2: 3, fill: "#f00" })).toContain("recharts-reference-area");
    expect(renderBar()).not.toContain("recharts-reference-area");
  });
});

describe("threshold chart raise tick", () => {
  const readings: MetricSeriesPoint[] = Array.from({ length: 24 }, (_, i) => ({
    bucket: T0 + i * HOUR,
    value: 5,
  }));
  const raisedAt = new Date(T0 + 9 * HOUR + 20 * 60 * 1000);

  it("fails when the threshold chart drops the raise tick", () => {
    const html = renderToStaticMarkup(
      createElement(AlertThresholdChart, { series: readings, threshold: 4, raisedAt })
    );
    expect(html).toContain("▲ raised 09:00");
  });

  it("fails when the multi-series chart drops the raise tick", () => {
    const html = renderToStaticMarkup(
      createElement(AlertMultiSeriesChart, {
        seriesMap: new Map([
          ["queue-a", readings],
          ["queue-b", readings],
        ]),
        threshold: 4,
        raisedAt,
      })
    );
    expect(html).toContain("▲ raised 09:00");
  });
});
