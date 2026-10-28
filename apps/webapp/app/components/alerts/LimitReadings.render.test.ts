import { getCapability } from "@internal/alert-contracts";
import { compileTSQL } from "@internal/tsql";
import type * as RechartsModule from "recharts";
import type * as ThresholdChartModule from "./AlertThresholdChart";
import { cloneElement, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AlertDetail } from "~/presenters/v3/AlertDetailPresenter.server";
import { querySchemas } from "~/v3/querySchemas";
import {
  getLimitTileSeries,
  limitTileKeys,
  limitTileQuery,
} from "~/v3/services/alerts/healthQuerySeries.server";
import { AlertDetailChart } from "./AlertDetailChart";
import { isLimitComponent, type LimitTileSeries } from "./limitTiles";

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
vi.mock("~/hooks/useShortcutKeys", () => ({ useShortcutKeys: () => {} }));
vi.mock("~/components/primitives/DateTime", () => ({ useUserTimeZone: () => "UTC" }));
vi.mock("~/components/runs/v3/SharedFilters", () => ({ TimeFilter: () => null }));
vi.mock("~/components/primitives/DetailChartBlock", () => ({
  DetailChartBlock: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));
vi.mock("./PreviewChartCard", () => ({
  PreviewChartCard: ({
    children,
    accessory,
    legend,
  }: {
    children: ReactNode;
    accessory?: ReactNode;
    legend?: { label: string }[];
  }) =>
    createElement(
      "div",
      null,
      accessory,
      (legend ?? []).map((item) =>
        createElement("b", { key: item.label, "data-legend": item.label })
      ),
      children
    ),
}));
vi.mock("./GroupsDropdown", () => ({
  GroupsDropdown: ({
    groups,
    selected,
    noun,
  }: {
    groups: string[];
    selected: string[];
    noun?: string;
  }) =>
    createElement("u", {
      "data-dropdown": noun,
      "data-groups": groups.length,
      "data-selected": selected.join("|"),
    }),
}));
vi.mock("./AlertThresholdChart", async (importOriginal) => {
  const actual = await importOriginal<typeof ThresholdChartModule>();
  return {
    ...actual,
    AlertMultiSeriesChart: (props: any) =>
      createElement(
        "div",
        { "data-shared-chart": "multi" },
        createElement(actual.AlertMultiSeriesChart, props)
      ),
    AlertThresholdChart: (props: any) =>
      createElement(
        "div",
        { "data-shared-chart": "single" },
        createElement(actual.AlertThresholdChart, props)
      ),
  };
});
vi.mock("./AlertDetailCharts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  HealthActivityChart: () => createElement("i", { "data-chart": "activity" }),
}));
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);
const window = { since: new Date(T0), until: new Date(T0 + 4 * HOUR) };

const tile = (key: string, values: (number | null)[]): LimitTileSeries => ({
  key,
  label: getCapability(key)!.shortTitle!,
  threshold: 80,
  points: values.map((value, i) => ({ bucket: T0 + i * HOUR, value })),
});

const outcomes = (components: Record<string, object>, failedComponents?: string[]) => ({
  status: "available",
  result: {
    kind: "stateful",
    outcome: "met",
    facts: {
      components: Object.fromEntries(
        Object.entries(components).map(([k, c]) => [k, { effectiveParams: {}, ...c }])
      ),
      failedComponents,
    },
  },
});

const composite = (components: Record<string, object>, failedComponents?: string[]) =>
  ({
    kind: "state",
    capabilityKey: "limits.all",
    capabilityTitle: "Watch all limits",
    status: { status: "active" },
    episode: { raisedAt: null, outcome: "none" },
    events: [],
    evaluated: true,
    stateOutcome: "met",
    currentReading: outcomes(components, failedComponents),
  }) as unknown as AlertDetail;

function render(alert: AlertDetail, limitTiles: LimitTileSeries[], _lines = 0) {
  return renderToStaticMarkup(
    createElement(AlertDetailChart, {
      alert,
      metricSeriesMap: new Map(),
      healthBands: [{ bucket: T0, degraded: null, healthy: 1, unknown: null }],
      limitTiles,
      window,
      now: new Date(T0 + 4 * HOUR),
    })
  );
}

const title = (key: string) => getCapability(key)!.shortTitle!;

const legendLabels = (html: string) =>
  [...html.matchAll(/data-legend="([^"]*)"/g)].map((m) => m[1]);

describe("limits detail chart", () => {
  it("fails when limits.api is classified as a percent line instead of a limit", () => {
    expect(isLimitComponent("limits.api")).toBe(true);
    expect(isLimitComponent("health.flow")).toBe(false);
    expect(limitTileKeys(getCapability("limits.all")!, undefined)).toHaveLength(7);
    expect(limitTileKeys(getCapability("limits.queue")!)).toEqual(["limits.queue"]);
  });

  const three = () =>
    render(
      composite({
        "limits.api": { outcome: "met" },
        "limits.concurrency": { outcome: "not_met" },
        "limits.queue": { outcome: "not_met" },
      }),
      [
        tile("limits.api", [10, 20, 30, 40]),
        tile("limits.concurrency", [20, 95, 40, 30]),
        tile("limits.queue", [5, 5, 5, 5]),
      ]
    );

  it("draws one chart with a line per limit, a threshold line and the groups dropdown", () => {
    const html = three();
    expect(html).toContain('data-dropdown="limits"');
    expect(html).toContain('data-groups="3"');
    expect(legendLabels(html)).toEqual(
      expect.arrayContaining([
        title("limits.api"),
        title("limits.concurrency"),
        title("limits.queue"),
      ])
    );
    expect(legendLabels(html)).not.toContain(getCapability("limits.api")!.title);
    expect(html).toContain("Threshold 80%");
    expect(html).toMatch(/stroke="var\(--color-warning\)"/);
  });

  it("selects the limit that crossed the threshold first", () => {
    const selected = /data-selected="([^"]*)"/.exec(three())![1]!.split("|");
    expect(selected[0]).toBe(title("limits.concurrency"));
  });

  it("renders through the same chart components as a grouped and a scalar query alert", () => {
    const queryAlert = (scopeType: string) =>
      ({
        kind: "threshold",
        capabilityKey: "queue.depth",
        capabilityTitle: "Queue depth",
        scope: { type: scopeType },
        operator: ">",
        thresholdValue: 80,
        unitSuffix: "%",
        currentReading: { status: "unavailable" },
        status: { status: "active" },
        episode: { raisedAt: null, outcome: "none" },
        events: [],
        evaluated: true,
      }) as unknown as AlertDetail;
    const points = [10, 90, 30, 40].map((value, i) => ({ bucket: T0 + i * HOUR, value }));
    const asQuery = (alert: AlertDetail, map: Map<string, typeof points>, groups?: string[]) =>
      renderToStaticMarkup(
        createElement(AlertDetailChart, {
          alert,
          metricSeriesMap: map,
          healthBands: [],
          queryGroups: groups,
          querySeriesMode: "threshold",
          window,
          now: new Date(T0 + 4 * HOUR),
        })
      );
    const queryGrouped = asQuery(
      queryAlert("queue"),
      new Map([
        ["a", points],
        ["b", points],
      ]),
      ["a", "b"]
    );
    const limitsGrouped = three();
    expect(queryGrouped).toContain('data-shared-chart="multi"');
    expect(limitsGrouped).toContain('data-shared-chart="multi"');
    expect(queryGrouped).toContain("data-groups=");
    expect(limitsGrouped).toContain("data-groups=");
    const queryScalar = asQuery(queryAlert("all"), new Map([["__agg__", points]]));
    const limitsScalar = render(composite({ "limits.api": { outcome: "met" } }), [
      tile("limits.api", [10, 90, 30, 40]),
    ]);
    expect(queryScalar).toContain('data-shared-chart="single"');
    expect(limitsScalar).toContain('data-shared-chart="single"');
    expect(limitsScalar).not.toContain("data-dropdown");
  });

  it("says the data could not be loaded when every limit failed", () => {
    const html = render(composite({ "limits.api": { outcome: "not_met" } }), [
      { ...tile("limits.api", []), failed: true },
    ]);
    expect(html).toContain("Couldn&#x27;t load this data");
  });

  it("drops components without data or with a failed query and shows the empty chart when none remain", () => {
    const some = render(
      composite({ "limits.api": { outcome: "met" }, "limits.queue": { outcome: "not_met" } }),
      [
        tile("limits.api", [null, null]),
        { ...tile("limits.queue", [5, 5, 5, 5]) },
        { ...tile("limits.concurrency", [9, 9, 9, 9]), failed: true },
      ]
    );
    expect(legendLabels(some)).toContain(title("limits.queue"));
    expect(legendLabels(some)).not.toContain(title("limits.api"));
    expect(legendLabels(some)).not.toContain(title("limits.concurrency"));
    expect(some).not.toContain("data-dropdown");
    const none = render(composite({ "limits.api": { outcome: "unavailable" } }), [
      tile("limits.api", [null, null]),
    ]);
    expect(none).not.toContain('data-component="');
    expect(none).not.toContain("recharts-line-curve");
  });
});

describe("limit tile queries", () => {
  const compile = (key: string) => {
    const cap = getCapability(key)!;
    const params = Object.fromEntries((cap.binding.params ?? []).map((p) => [p.key, p.default]));
    const query = limitTileQuery(
      cap,
      { environmentId: "env_1", scope: { type: "all" } } as never,
      params,
      300,
      48
    );
    expect(query).toBeDefined();
    return compileTSQL(query!.replace(/\bFROM (env_metrics|metrics)\b/g, "FROM $1"), {
      tableSchema: querySchemas,
      enforcedWhereClause: {
        organization_id: { op: "eq", value: "org_1" },
        project_id: { op: "eq", value: "proj_1" },
        environment_id: { op: "eq", value: "env_1" },
      },
    }).sql;
  };

  it.each([
    "limits.api",
    "limits.concurrency",
    "limits.queue",
    "limits.webhooks.processing",
    "limits.webhooks.env_rate",
    "limits.webhooks.endpoint_rate",
    "limits.webhooks.waiters",
  ])("%s compiles", (key) => {
    expect(compile(key)).toContain("toStartOfInterval(bucket_start");
  });

  it("partitions the endpoint rate per endpoint", () => {
    expect(compile("limits.webhooks.endpoint_rate")).toContain(
      "GROUP BY sub_bucket, metric_subject"
    );
  });

  it("returns nothing for a template it cannot parse", () => {
    const cap = getCapability("limits.api")!;
    const broken = {
      ...cap,
      binding: { ...cap.binding, signalTemplates: { approaching: "SELECT 1 FROM metrics" } },
    };
    expect(limitTileQuery(broken, {} as never, {}, 300, 48)).toBeUndefined();
  });
});

describe("limit tile series", () => {
  const input = (key: string) => ({
    alertId: "a",
    capability: getCapability(key)!,
    params: { environmentId: "env_1", scope: { type: "all" } },
    condition: { kind: "state", stateKey: "health" },
    organizationId: "o",
    projectId: "p",
    window,
  });

  it("retries a concurrency-rejected query so the other series still render", async () => {
    let calls = 0;
    const rejectSecond = async () => {
      calls += 1;
      if (calls === 2)
        throw Object.assign(new Error("lane full"), { __queryConcurrencyRejection: true });
      return [{ bucket: "2026-01-01 00:00:00", value: 4 }];
    };
    const tiles = await getLimitTileSeries(
      {
        ...input("limits.all"),
        condition: {
          kind: "state",
          stateKey: "health",
          components: ["limits.api", "limits.concurrency", "limits.queue"],
        },
      } as never,
      rejectSecond as never
    );
    expect(tiles.map((t) => t.failed)).toEqual([false, false, false]);
    expect(tiles.every((t) => t.points.some((p) => p.value === 4))).toBe(true);
  });

  it("marks a component failed when its fetch rejects and still returns the others", async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 3) throw new Error("boom");
      return [{ bucket: "2026-01-01 00:00:00", value: 4 }];
    };
    const tiles = await getLimitTileSeries(
      {
        ...input("limits.all"),
        condition: {
          kind: "state",
          stateKey: "health",
          components: ["limits.api", "limits.concurrency", "limits.queue"],
        },
      } as never,
      flaky as never
    );
    expect(tiles.map((t) => [t.key, !!t.failed])).toEqual([
      ["limits.api", false],
      ["limits.concurrency", false],
      ["limits.queue", true],
    ]);
    expect(tiles[1]!.points.some((p) => p.value === 4)).toBe(true);
    expect(tiles[0]!.label).toBe(getCapability("limits.api")!.shortTitle);
  });
});
