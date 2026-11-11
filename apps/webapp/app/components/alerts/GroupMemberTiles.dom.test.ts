// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { PreviewChartCard } from "./PreviewChartCard";
import { GroupMembershipBanner, GroupMemberTiles } from "./GroupMemberTiles";
import { tileHasData, type GroupMemberTile } from "./groupMembers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

vi.mock("~/components/primitives/charts/ChartCard", () => ({
  ChartCard: ({
    title,
    accessory,
    maximizable,
    children,
  }: {
    maximizable?: boolean;
    title: React.ReactNode;
    accessory?: React.ReactNode;
    children: React.ReactNode;
  }) =>
    createElement(
      "div",
      null,
      createElement("header", null, title),
      accessory,
      createElement("main", { "data-maximizable": String(maximizable) }, children)
    ),
}));
vi.mock("~/components/primitives/Tooltip", () => ({
  SimpleTooltip: ({ button, content }: { button: React.ReactNode; content: React.ReactNode }) =>
    createElement("span", { "data-tooltip": String(content) }, button),
  InfoIconTooltip: () => createElement("b"),
}));
vi.mock("~/components/primitives/DateTime", () => ({ useUserTimeZone: () => "UTC" }));
vi.mock("~/components/queues/MetricTileChart", () => ({
  MetricTileChart: ({ referenceLines }: { referenceLines?: { y: number; label?: string }[] }) =>
    createElement("i", { "data-chart": "threshold", "data-ref": referenceLines?.[0]?.label }),
}));

async function mount(
  element: React.ReactElement,
  action?: (args: { request: Request }) => unknown
) {
  const wrapped = createElement(
    OperatingSystemContextProvider,
    { platform: "mac" },
    createElement(ShortcutsProvider, null, element)
  );
  const router = createMemoryRouter([{ path: "/", action, element: wrapped }]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(RouterProvider, { router })));
  return container;
}

const IDS = ["m0", "m1", "m2", "m3", "m4"];

function tile(id: string, peak: number | null = 93): GroupMemberTile {
  return {
    id,
    name: `Alert ${id}`,
    alert: {
      kind: "threshold",
      capabilityKey: "queue.depth",
      capabilityTitle: "Depth",
      conditionSummary: "> 5",
      operator: ">",
      thresholdValue: 50,
      scope: { type: "all" },
      unitSuffix: "%",
      events: [],
      episode: { raisedAt: null },
      currentReading: { status: "unavailable" },
    },
    createdAt: new Date(0),
    metricSeriesEntries: peak === null ? [] : [["__agg__", [{ bucket: 1, value: peak }]]],
    healthBands: [],
    componentSeries: [],
    limitTiles: [],
    queryGroups: [],
    querySeriesMode: undefined,
  } as unknown as GroupMemberTile;
}

describe("tileHasData", () => {
  // Catches: a state tile with only component metric series rendering as "No activity".
  it("counts component metric series for state tiles", () => {
    const state = tile("m0", null);
    state.alert = { ...state.alert, kind: "state" } as GroupMemberTile["alert"];
    expect(tileHasData(state)).toBe(false);
    state.componentSeries = [
      {
        key: "failureRatePct",
        label: "Failure rate",
        threshold: 10,
        points: [{ bucket: 1, value: null }],
      },
    ];
    expect(tileHasData(state)).toBe(false);
    state.componentSeries = [
      {
        key: "failureRatePct",
        label: "Failure rate",
        threshold: 10,
        points: [{ bucket: 1, value: 2 }],
      },
    ];
    expect(tileHasData(state)).toBe(true);
  });
});

describe("GroupMemberTiles", () => {
  it("renders one compact chart tile per member in a 3-column grid, no link and no status", async () => {
    const container = await mount(
      createElement(GroupMemberTiles, {
        tiles: IDS.map((id) => tile(id)),
        window: { since: new Date(0), until: new Date(1000) },
        now: new Date(1000),
      })
    );
    const grid = container.querySelector('[data-testid="group-member-tiles"]')!;
    const tiles = [...grid.querySelectorAll('[data-testid="member-tile"]')];
    expect(tiles).toHaveLength(5);
    expect(tiles[2]!.querySelector("header")!.textContent).toContain("Alert m2");
    expect(tiles[2]!.querySelector("header")!.textContent).not.toContain("peak");
    expect(tiles[2]!.querySelector("i")!.getAttribute("data-chart")).toBe("threshold");
    const title = tiles[2]!.querySelector("header [data-tooltip]")!;
    expect(title.getAttribute("data-tooltip")).toContain("Alert m2");
    expect(tiles[2]!.querySelector("header")!.textContent).not.toContain("peak");
    expect(tiles.every((t) => t.querySelector("header b"))).toBe(true);
    expect(tiles[2]!.querySelector("i")!.getAttribute("data-ref")).toBe("50%");
    expect(grid.querySelector("a")).toBeNull();
    expect(grid.textContent).not.toMatch(/Fired|Query failed|Stopped|No data/);
    expect(tiles[2]!.querySelector("main")!.getAttribute("data-maximizable")).not.toBe("false");
  });

  it("a tile without data shows the empty state and no peak", async () => {
    const container = await mount(
      createElement(GroupMemberTiles, {
        tiles: [tile("m0", null)],
        window: { since: new Date(0), until: new Date(1000) },
        now: new Date(1000),
      })
    );
    const only = container.querySelector('[data-testid="member-tile"]')!;
    expect(only.textContent).toContain("No activity");
    expect(only.querySelector("header")!.textContent).not.toContain("peak");
  });
});

describe("tile legend", () => {
  it("shows the warning item and one series inline, the rest behind See all", async () => {
    const items = [
      { swatch: "line" as const, color: "#111", label: "Series A" },
      { swatch: "line" as const, color: "#222", label: "Series B" },
      { swatch: "line" as const, color: "#333", label: "Series C" },
      { swatch: "line" as const, color: "var(--color-warning)", label: "Above threshold" },
    ];
    const container = await mount(
      createElement(PreviewChartCard, { title: "T", legend: items, tile: { peak: null } }, null)
    );
    expect(container.textContent).toContain("Above threshold");
    expect(container.textContent).toContain("Series A");
    expect(container.textContent).not.toContain("Series B");
    const seeAll = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "See all"
    )!;
    await act(async () => seeAll.click());
    const popover = document.body.querySelector("[role=dialog]")!.textContent;
    expect(popover).toContain("Series B");
    expect(popover).toContain("Series C");
  });
});

describe("GroupMembershipBanner", () => {
  it("names the group and links to it", async () => {
    const container = await mount(
      createElement(GroupMembershipBanner, { name: "Prod group", to: "/alerts/g1" })
    );
    const banner = container.querySelector('[data-testid="group-membership-banner"]')!;
    expect(banner.textContent?.trim()).toBe("In group Prod group");
    expect(banner.querySelector("a")!.getAttribute("href")).toBe("/alerts/g1");
  });
});
