// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeSquareIcon } from "~/assets/icons/CodeSquareIcon";
import type { AlertDetail } from "~/presenters/v3/AlertDetailPresenter.server";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { AlertDetailChart } from "./AlertDetailChart";
import { AREA_OPTIONS } from "./AlertsList";
import { WARNING_COLOR } from "./ChartLegend";
import { AREA_ICON, AREA_LABEL, isAlertArea } from "./domainIcons";
import type { MetricSeriesPoint } from "./alertSeriesTypes";
import { defaultGroupSelection } from "./queryGroupSelection";
import type * as AlertThresholdChartModule from "./AlertThresholdChart";

const { assignGroupColors, AlertMultiSeriesChart, SERIES_COLORS, thresholdChartLegend } =
  await vi.importActual<typeof AlertThresholdChartModule>("./AlertThresholdChart");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("~/components/primitives/charts/ChartCompound", () => ({
  Chart: {
    Root: ({
      children,
      series,
      config,
    }: {
      children: ReactNode;
      series: string[];
      config: Record<string, { color?: string }>;
    }) =>
      createElement(
        "div",
        {
          "data-series": series.join(","),
          "data-colors": Object.values(config)
            .map((c) => c.color)
            .join(","),
        },
        children
      ),
    Line: ({ warningOverlay }: { warningOverlay?: unknown }) =>
      createElement("i", { "data-overlay": JSON.stringify(warningOverlay) }),
  },
}));
vi.mock("~/components/primitives/DateTime", () => ({ useUserTimeZone: () => "UTC" }));
vi.mock("~/components/runs/v3/SharedFilters", () => ({ TimeFilter: () => null }));
vi.mock("~/components/primitives/DetailChartBlock", () => ({
  DetailChartBlock: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./PreviewChartCard", () => ({
  PreviewChartCard: ({ accessory, children }: { accessory?: ReactNode; children: ReactNode }) =>
    createElement("div", null, accessory, children),
}));
vi.mock("./ActivityBars", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ActivityBars: ({ data }: { data: unknown[] }) =>
    createElement("i", { "data-chart": "bars", "data-points": data.length }),
}));
vi.mock("./AlertThresholdChart", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  AlertMultiSeriesChart: ({ seriesMap }: { seriesMap: Map<string, unknown> }) =>
    createElement("i", { "data-chart": "multi", "data-keys": [...seriesMap.keys()].join(",") }),
}));

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

const alert = {
  kind: "threshold",
  capabilityTitle: "Custom",
  capabilityKey: "custom.query",
  operator: ">",
  thresholdValue: 10,
  scope: { type: "all" },
  status: { status: "active" },
  episode: { raisedAt: new Date(T0), outcome: "raised" },
  events: [],
  currentReading: { status: "unavailable" },
} as unknown as AlertDetail;

const points = (...values: number[]): MetricSeriesPoint[] =>
  values.map((value, i) => ({ bucket: T0 + i * HOUR, value }));

// g8 and g9 cross the threshold; the others stay below and rise with their index
const groups = Array.from({ length: 10 }, (_, i) => `g${i}`);
const seriesMap = new Map(groups.map((g, i) => [g, points(i >= 8 ? 50 + i : i, 1)]));

let root: Root | undefined;
let container: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  document.body.innerHTML = "";
});

function mount(props: Record<string, unknown> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  render(props);
  return container;
}

function render(props: Record<string, unknown> = {}) {
  act(() =>
    root!.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(
          ShortcutsProvider,
          null,
          createElement(AlertDetailChart, {
            alert,
            metricSeriesMap: seriesMap,
            healthBands: [],
            window: { since: new Date(T0), until: new Date(T0 + 4 * HOUR) },
            now: new Date(T0 + 4 * HOUR),
            queryGroups: groups,
            querySeriesMode: "threshold",
            ...props,
          } as never)
        )
      )
    )
  );
}

const keys = (c: HTMLElement) =>
  c.querySelector("[data-chart=multi]")!.getAttribute("data-keys")!.split(",");

describe("defaultGroupSelection", () => {
  it("puts crossed groups first, then closest to the threshold, capped at 8", () => {
    const picked = defaultGroupSelection({ groups, seriesMap, operator: ">" });
    expect(picked).toEqual(["g9", "g8", "g7", "g6", "g5", "g4", "g3", "g2"]);
  });

  it("orders toward the threshold for a below-threshold operator", () => {
    const picked = defaultGroupSelection({
      groups: ["a", "b", "c"],
      seriesMap: new Map([
        ["a", points(5)],
        ["b", points(1)],
        ["c", points(3)],
      ]),
      operator: "<",
    });
    expect(picked).toEqual(["b", "c", "a"]);
  });
});

describe("AlertDetailChart query groups", () => {
  it("renders at most 8 series by default, crossed groups first", () => {
    const c = mount();
    expect(keys(c)).toEqual(["g9", "g8", "g7", "g6", "g5", "g4", "g3", "g2"]);
    expect(c.textContent).toContain("Groups 8/10");
  });

  it("hides a series when its group is toggled off and searches the list", () => {
    const c = mount();
    act(() => c.querySelector<HTMLElement>("button")!.click());

    const search = document.querySelector<HTMLInputElement>("input")!;
    expect(search.placeholder).toContain("Up to 8 visible");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    const type = (value: string) =>
      act(() => {
        setter.call(search, value);
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const rows = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
    const g0 = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => o.textContent === "g0"
    )!;
    expect(g0.getAttribute("aria-disabled")).toBe("true");
    type("g1");
    expect(rows()).toEqual(["g1"]);

    type("");
    const row = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => o.textContent === "g9"
    )!;
    act(() => row.click());
    expect(keys(c)).not.toContain("g9");
    expect(c.textContent).toContain("Groups 7/10");
  });

  it("shows the picker only with at least two groups", () => {
    expect(mount({ queryGroups: ["g9"] }).textContent).not.toContain("Groups");
    act(() => root?.unmount());
    container?.remove();
    expect(mount({ queryGroups: ["g9", "g8"] }).textContent).toContain("Groups 2/2");
    act(() => container!.querySelector<HTMLElement>("button")!.click());
    expect(document.querySelector<HTMLInputElement>("input")!.placeholder).not.toContain("Up to");
  });

  it("shows the only remaining group even after it was deselected", () => {
    const c = mount({ queryGroups: ["g9", "g8"] });
    act(() => c.querySelector<HTMLElement>("button")!.click());
    const g9 = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (o) => o.textContent === "g9"
    )!;
    act(() => g9.click());
    expect(keys(c)).toEqual(["g8"]);

    render({ queryGroups: ["g9"] });
    expect(keys(c)).toEqual(["g9"]);
    expect(c.textContent).not.toContain("Groups");
  });

  it("renders the occurrence bar chart in match mode", () => {
    const c = mount({
      querySeriesMode: "match",
      metricSeriesMap: new Map([["__agg__", points(2, 3, 4)]]),
    });
    expect(c.querySelector("[data-chart=bars]")!.getAttribute("data-points")).toBe("3");
    expect(c.querySelector("[data-chart=multi]")).toBeNull();
  });
});

describe("Watching area for custom queries", () => {
  it("shows Custom with the Query page icon", () => {
    expect(AREA_LABEL.query).toBe("Custom");
    expect(AREA_ICON.query).toBe(CodeSquareIcon);
    expect(isAlertArea("query")).toBe(true);
    expect(AREA_OPTIONS).toContainEqual({ value: "query", label: "Custom" });
  });
});

function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

describe("grouped chart threshold highlight", () => {
  it("keeps yellow and amber out of the series colours", () => {
    expect(SERIES_COLORS).toHaveLength(8);
    for (const color of SERIES_COLORS) {
      const h = hue(color);
      expect(h < 20 || h > 75, color).toBe(true);
    }
  });

  it("applies the warning overlay to the chart holding every group", () => {
    const html = renderToStaticMarkup(
      createElement(AlertMultiSeriesChart, {
        seriesMap: new Map([
          ["a", points(1, 20, 25)],
          ["b", points(2, 30, 15)],
        ]),
        threshold: 10,
        operator: ">",
      })
    );
    expect(html).toContain('data-series="a,b"');
    expect(html).toContain("&quot;direction&quot;:&quot;above&quot;");
    expect(html).toContain("var(--color-warning)");
  });
});

describe("assignGroupColors", () => {
  const keys = Array.from({ length: 12 }, (_, i) => `g${i}`);

  it("gives 8 visible groups 8 distinct colours", () => {
    const colors = assignGroupColors(new Map(), keys.slice(0, 8));
    expect(new Set(colors.values()).size).toBe(8);
  });

  it("stays distinct for 12 groups with 8 selected", () => {
    const colors = assignGroupColors(new Map(), keys.slice(2, 10));
    expect(colors.size).toBe(8);
    expect(new Set(colors.values()).size).toBe(8);
  });

  it("keeps untouched colours when one is toggled off and another on", () => {
    const first = assignGroupColors(new Map(), keys.slice(0, 8));
    const next = assignGroupColors(first, [...keys.slice(1, 8), "g10"]);
    expect(new Set(next.values()).size).toBe(8);
    for (const key of keys.slice(1, 8)) expect(next.get(key)).toBe(first.get(key));
    expect(next.get("g10")).toBe(first.get("g0"));
  });
});

describe("grouped chart legend", () => {
  const seriesMap = new Map([
    ["a", points(1, 20)],
    ["b", points(2, 30)],
  ]);

  it("lists every colour it draws, warning entry included", () => {
    const input = { seriesMap, label: "x", threshold: 10, operator: ">" as const };
    const legend = thresholdChartLegend(input);
    expect(legend.map((i) => i.label)).toEqual(["a", "b", "Above threshold"]);
    expect(legend.map((i) => i.color)).toEqual([SERIES_COLORS[0], SERIES_COLORS[1], WARNING_COLOR]);
  });

  it("omits it without a threshold", () => {
    const labels = thresholdChartLegend({ seriesMap, label: "x", threshold: null }).map(
      (i) => i.label
    );
    expect(labels).toEqual(["a", "b"]);
  });

  it("keeps a lone group's assigned colour in the line and the legend", () => {
    const colors = new Map([["b", SERIES_COLORS[1]!]]);
    const single = new Map([["b", points(2, 30)]]);
    const html = renderToStaticMarkup(
      createElement(AlertMultiSeriesChart, { seriesMap: single, threshold: 10, colors })
    );
    expect(html).toContain(`data-colors="${SERIES_COLORS[1]}"`);
    const legend = thresholdChartLegend({ seriesMap: single, label: "x", threshold: null, colors });
    expect(legend.map((i) => i.color)).toEqual([SERIES_COLORS[1]]);
  });
});
