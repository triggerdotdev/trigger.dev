import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AlertDetail } from "~/presenters/v3/AlertDetailPresenter.server";
import type { HealthQuerySeries } from "./alertSeriesTypes";
import { AlertDetailChart } from "./AlertDetailChart";

vi.mock("~/components/primitives/DateTime", () => ({ useUserTimeZone: () => "UTC" }));
vi.mock("~/components/runs/v3/SharedFilters", () => ({ TimeFilter: () => null }));
vi.mock("~/components/primitives/DetailChartBlock", () => ({
  DetailChartBlock: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./PreviewChartCard", () => ({
  PreviewChartCard: ({ accessory, children }: { accessory?: ReactNode; children: ReactNode }) =>
    createElement("div", null, accessory, children),
}));
vi.mock("./AlertDetailCharts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  AbsenceActivityChart: ({ trailing }: { trailing?: unknown }) =>
    createElement("i", { "data-trailing": String(Boolean(trailing)) }),
  HealthActivityChart: ({
    bands,
    current,
  }: {
    bands: { degraded: number | null }[];
    current?: number;
  }) =>
    createElement("i", {
      "data-chart": "activity",
      "data-current": String(current),
      "data-degraded": bands.filter((b) => b.degraded).length,
    }),
}));
vi.mock("./AlertThresholdChart", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  AlertThresholdChart: ({ threshold }: { threshold: number | null }) =>
    createElement("i", { "data-threshold": String(threshold) }),
}));
vi.mock("./AlertHealthQueriesChart", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  AlertHealthQueriesChart: () => createElement("i", { "data-chart": "metrics" }),
}));

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

const alert = {
  kind: "state",
  capabilityTitle: "Health",
  status: { status: "active" },
  episode: { raisedAt: new Date(T0), outcome: "raised" },
  events: [],
  evaluated: true,
} as unknown as AlertDetail;

const series = (key: string): HealthQuerySeries =>
  ({
    key,
    label: key,
    points: [{ bucket: T0, value: 1 }],
  }) as unknown as HealthQuerySeries;

function render(count: number) {
  return renderToStaticMarkup(
    createElement(AlertDetailChart, {
      alert,
      metricSeriesMap: new Map(),
      healthBands: [{ bucket: T0, degraded: null, healthy: 1, unknown: null }],
      componentSeries: Array.from({ length: count }, (_, i) => series(`s${i}`)),
      window: { since: new Date(T0), until: new Date(T0 + HOUR) },
      now: new Date(T0 + HOUR),
    })
  );
}

describe("AlertDetailChart health view", () => {
  it("shows only the metric chart for a single metric", () => {
    const html = render(1);
    expect(html).not.toContain('role="radio"');
    expect(html).toContain('data-chart="metrics"');
    expect(html).not.toContain('data-chart="activity"');
  });

  it("shows the toggle for several metrics", () => {
    const html = render(2);
    expect(html).toContain('role="radio"');
    expect(html).toContain('data-chart="activity"');
  });

  it("shows the activity chart without a toggle when there are no metrics", () => {
    const html = render(0);
    expect(html).not.toContain('role="radio"');
    expect(html).toContain('data-chart="activity"');
  });
});

describe("AlertDetailChart threshold", () => {
  const thresholdAlert = (currentReading: unknown) =>
    ({
      kind: "threshold",
      capabilityKey: "queue.depth",
      capabilityTitle: "Queue depth",
      scope: { type: "all" },
      operator: ">",
      thresholdValue: 10,
      currentReading,
      status: { status: "active" },
      episode: { raisedAt: null, outcome: "none" },
      events: [],
      evaluated: true,
    }) as unknown as AlertDetail;

  const renderThreshold = (currentReading: unknown) =>
    renderToStaticMarkup(
      createElement(AlertDetailChart, {
        alert: thresholdAlert(currentReading),
        metricSeriesMap: new Map(),
        healthBands: [],
        window: { since: new Date(T0), until: new Date(T0 + HOUR) },
        now: new Date(T0 + HOUR),
      })
    );

  it("keeps the configured threshold when the live reading is unavailable", () => {
    expect(renderThreshold({ status: "unavailable" })).toContain('data-threshold="10"');
  });

  it("prefers the live reading threshold", () => {
    const html = renderThreshold({
      status: "available",
      result: { kind: "stateful", outcome: "met", facts: { threshold: 25 } },
    });
    expect(html).toContain('data-threshold="25"');
  });
});

describe("AlertDetailChart historical window", () => {
  const raised = (raisedAt: Date | null) =>
    ({ ...alert, episode: { raisedAt, outcome: "raised" } }) as unknown as AlertDetail;

  const renderWindow = (alertDetail: AlertDetail, until: number, explicitTo = false) =>
    renderToStaticMarkup(
      createElement(AlertDetailChart, {
        alert: alertDetail,
        metricSeriesMap: new Map(),
        healthBands: [
          { bucket: T0 - 4 * HOUR, degraded: null, healthy: 1, unknown: null },
          { bucket: T0, degraded: null, healthy: 1, unknown: null },
        ],
        componentSeries: [],
        window: { since: new Date(T0 - 8 * HOUR), until: new Date(until), explicitTo },
        now: new Date(T0 + 100 * HOUR),
        healthView: "together",
      } as never)
    );

  it("shows no Now point or degraded band when the raise is after the window", () => {
    const html = renderWindow(raised(new Date(T0 + 50 * HOUR)), T0 + 4 * HOUR);
    expect(html).toContain('data-current="undefined"');
    expect(html).toContain('data-degraded="0"');
  });

  it("paints no degraded band for a historical window without a raise time", () => {
    const html = renderWindow(raised(null), T0 + 4 * HOUR);
    expect(html).toContain('data-degraded="0"');
  });

  it("treats an explicit recent end as historical", () => {
    const html = renderWindow(raised(new Date(T0 + 99 * HOUR)), T0 + 97 * HOUR, true);
    expect(html).toContain('data-current="undefined"');
    expect(html).toContain('data-degraded="0"');
  });

  it("keeps the Now point on a live window", () => {
    const html = renderWindow(raised(new Date(T0 + 50 * HOUR)), T0 + 100 * HOUR);
    expect(html).toContain('data-current="0"');
  });
});

describe("AlertDetailChart absence silence", () => {
  const absence = {
    kind: "absence",
    capabilityTitle: "Absence",
    windowSec: 3600,
    status: { status: "needs_attention" },
    episode: { raisedAt: new Date(T0 + 99 * HOUR), recoveredAt: null, outcome: "raised" },
    events: [],
    evaluated: true,
  } as unknown as AlertDetail;

  const renderAbsence = (explicitTo: boolean) =>
    renderToStaticMarkup(
      createElement(AlertDetailChart, {
        alert: absence,
        metricSeriesMap: new Map(),
        healthBands: [],
        window: { since: new Date(T0), until: new Date(T0 + 50 * HOUR), explicitTo },
        now: new Date(T0 + 100 * HOUR),
      } as never)
    );

  it("drops present-day silence from an explicit historical window", () => {
    expect(renderAbsence(true)).toContain('data-trailing="false"');
  });

  it("keeps the silence on the default live window", () => {
    expect(renderAbsence(false)).toContain('data-trailing="true"');
  });
});
