import type * as RechartsModule from "recharts";
import { cloneElement, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AlertHealthQueriesChart,
  drawnHealthSeries,
  HEALTH_LINE_COLORS,
  healthQueriesLegend,
} from "./AlertHealthQueriesChart";
import { dropTicksNearRaise, HealthActivityChart, healthAxis } from "./AlertDetailCharts";
import { sliceHealthCard } from "./alertDetailWindow";
import type { HealthBandRow, HealthQuerySeries } from "./alertSeriesTypes";

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

const T0 = Date.UTC(2026, 0, 1);
const points = (values: number[]) =>
  values.map((value, i) => ({ bucket: T0 + i * 60 * 60 * 1000, value }));

const series: HealthQuerySeries[] = [
  { key: "failureRatePct", label: "Failure rate", threshold: 10, points: points([20, 150, 40]) },
  { key: "durationP95Ms", label: "Duration p95", threshold: 1000, points: points([60, 80, 120]) },
];

describe("AlertHealthQueriesChart", () => {
  it("fails when a line does not turn warning above 100%", () => {
    const html = renderToStaticMarkup(
      createElement(AlertHealthQueriesChart, {
        series: [{ key: "q", label: "Q", threshold: 1, points: points([50, 50, 150, 50, 50]) }],
      })
    );
    const paths = (color: string) =>
      [...html.matchAll(/<path[^>]*recharts-line-curve[^>]*>/g)]
        .map((m) => m[0])
        .filter((p) => p.includes(`stroke="${color}"`))
        .map((p) => /\sd="([^"]*)"/.exec(p)?.[1] ?? "")
        .filter((d) => d.length > 0);
    expect(paths("var(--color-warning)")).toHaveLength(1);
    expect(html).not.toContain("recharts-reference-area");
    const base = paths(HEALTH_LINE_COLORS[0]!);
    expect(base).toHaveLength(1);
    expect(base[0]!.split("M").filter(Boolean)).toHaveLength(2);
  });

  it("fails when liveness is dropped or the legend lists an undrawn series", () => {
    const liveness: HealthQuerySeries = {
      key: "silenceSec",
      label: "Silence",
      threshold: 300,
      points: points([20, 90, 140]),
    };
    const empty: HealthQuerySeries = { key: "q", label: "Empty", threshold: 1, points: [] };
    const drawn = drawnHealthSeries([...series, liveness, empty]);
    const html = renderToStaticMarkup(createElement(AlertHealthQueriesChart, { series: drawn }));
    for (const color of HEALTH_LINE_COLORS.slice(0, 3)) expect(html).toContain(`stroke="${color}"`);
    expect(html).not.toContain(`stroke="${HEALTH_LINE_COLORS[3]}"`);
    expect(
      healthQueriesLegend(drawn)
        .filter((l) => l.label !== "Above threshold")
        .map((l) => l.label)
    ).toEqual(["Failure rate", "Duration p95", "Silence"]);
  });
});

describe("sliceHealthCard", () => {
  it("fails when a leading null run is plotted", () => {
    const window = { since: new Date(T0), until: new Date(T0 + 6 * 60 * 60 * 1000) };
    const leading = (offset: number) =>
      points([1, 2, 3, 4, 5, 6]).map((p, i) => ({ ...p, value: i < offset ? null : p.value * 40 }));
    const lines = (a: number, b: number): HealthQuerySeries[] => [
      { key: "a", label: "A", threshold: 1, points: leading(a) },
      { key: "b", label: "B", threshold: 1, points: leading(b) },
    ];
    const curves = (s: HealthQuerySeries[]) =>
      renderToStaticMarkup(createElement(AlertHealthQueriesChart, { series: s }))
        .match(/recharts-line-curve" d="[^"]*"/g)
        ?.join();
    const sliced = sliceHealthCard({ bands: [], lines: lines(3, 4), events: [] }, window).lines;
    expect(sliced.map((s) => s.points.length)).toEqual([3, 3]);
    expect(curves(sliced)).toEqual(
      curves(lines(3, 4).map((s) => ({ ...s, points: s.points.slice(3) })))
    );
    expect(curves(sliced)).not.toEqual(curves(lines(3, 4)));
  });

  it("fails when Together and Separate start at different buckets", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const at = (i: number) => T0 + i * 12 * 60 * 60 * 1000;
    const window = { since: new Date(T0), until: new Date(at(8)) };
    const bands: HealthBandRow[] = Array.from({ length: 8 }, (_, i) => ({
      bucket: at(i),
      degraded: null,
      healthy: 1,
      unknown: null,
    }));
    const line: HealthQuerySeries = {
      key: "q",
      label: "Q",
      threshold: 1,
      points: bands.map((b) => ({ bucket: b.bucket, value: b.bucket >= T0 + 2 * DAY ? 50 : null })),
    };
    const card = sliceHealthCard({ bands, lines: [line], events: [] }, window);
    expect(card.bands[0]!.bucket).toBe(T0);
    expect(card.lines[0]!.points[0]!.bucket).toBe(T0);
  });
});

describe("AlertHealthQueriesChart domain", () => {
  it("fails when Separate lines do not share Together's x-range", () => {
    const HOUR = 60 * 60 * 1000;
    const line = (from: number): HealthQuerySeries[] => [
      {
        key: "q",
        label: "Q",
        threshold: 1,
        points: Array.from({ length: 12 }, (_, i) => ({
          bucket: T0 + i * HOUR,
          value: i < from ? null : 50,
        })),
      },
    ];
    const firstX = (s: HealthQuerySeries[], domain?: [number, number]) =>
      Number(
        renderToStaticMarkup(createElement(AlertHealthQueriesChart, { series: s, domain })).match(
          /recharts-line-curve"[^>]* d="M([\d.]+)/
        )?.[1]
      );
    const domain: [number, number] = [T0, T0 + 12 * HOUR];
    const late = line(6).map((s) => ({ ...s, points: s.points.slice(6) }));
    expect(firstX(late, domain)).toBeGreaterThan(firstX(line(0), domain));
    expect(firstX(line(6), domain)).toBeCloseTo(firstX(late, domain));
  });
});

describe("Separate view ticks", () => {
  const HOUR = 60 * 60 * 1000;
  const bands: HealthBandRow[] = Array.from({ length: 18 }, (_, i) => ({
    bucket: T0 + i * 4 * HOUR,
    degraded: i >= 15 ? 1 : null,
    healthy: i >= 15 ? null : 1,
    unknown: null,
  }));
  const day: HealthQuerySeries[] = [
    {
      key: "q",
      label: "Q",
      threshold: 1,
      points: Array.from({ length: 24 }, (_, i) => ({
        bucket: T0 + 2 * 24 * HOUR + i * HOUR,
        value: 50,
      })),
    },
  ];
  const labels = (html: string) =>
    [...html.matchAll(/recharts-cartesian-axis-tick-value[^>]*>(?:<tspan[^>]*>)?([^<]*)</g)]
      .map((m) => m[1])
      .filter((t) => !t!.includes("%") && t !== "Healthy");
  const domain: [number, number] = [T0, T0 + 72 * HOUR];

  it("fails when a 1-day line span picks clock labels on a multi-day range", () => {
    const html = renderToStaticMarkup(
      createElement(AlertHealthQueriesChart, { series: day, domain })
    );
    expect(labels(html).length).toBeGreaterThan(0);
    for (const label of labels(html)) expect(label).not.toMatch(/^\d\d:\d\d$/);
  });

  it("fails when Separate ticks differ from Together's", () => {
    const raisedAt = new Date(T0 + 60 * HOUR + HOUR);
    const axis = healthAxis(bands, raisedAt, 0);
    const together = renderToStaticMarkup(
      createElement(HealthActivityChart, { bands, raisedAt, current: 0 })
    );
    const separate = renderToStaticMarkup(
      createElement(AlertHealthQueriesChart, { series: day, domain, axis })
    );
    expect(labels(together).some((l) => l!.includes("raised"))).toBe(true);
    expect(labels(separate)).toEqual(labels(together));
  });
});

describe("dropTicksNearRaise", () => {
  it("fails when a tick next to the raise tick is kept", () => {
    const [t0, t1, t2] = [T0, T0 + 50 * 60_000, T0 + 100 * 60_000];
    expect(dropTicksNearRaise([t0, t1, t2], t2 - 60_000)).toEqual([t0, t1]);
    expect(dropTicksNearRaise([t0, t1, t2], t1)).toEqual([t0, t1, t2]);
  });
});
