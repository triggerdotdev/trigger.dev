// @vitest-environment jsdom
import { createElement, type ComponentProps } from "react";
import { act } from "react-dom/test-utils";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { QueryAlertAnalysis } from "~/v3/services/alerts/queryAlerts/analyzeQueryForAlert.server";
import { DashboardAgentProvider } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { QueryWidget } from "~/components/metrics/QueryWidget";
import { activeWatchFilters, type WatchFilters } from "~/components/metrics/widgetWatch";
import { MAX_MESSAGE_CHARS } from "~/components/dashboard-agent/message-limits";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { organizationMatchId } from "~/hooks/useOrganizations";

type AgentValue = ComponentProps<typeof DashboardAgentProvider>["value"];

type Gate = {
  alertsFlag: boolean;
  alertsConfigured: boolean;
  userAdmin: boolean;
  impersonating: boolean;
};

const ENABLED: Gate = {
  alertsFlag: true,
  alertsConfigured: false,
  userAdmin: false,
  impersonating: false,
};

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const QUERY = "SELECT count() AS failures FROM runs";
const ANALYZE_PATH = "/resources/orgs/org/projects/proj/env/prod/alerts/analyze-query";
const REASON = "Remove time buckets from GROUP BY.";

function analysis(partial: Partial<QueryAlertAnalysis>): QueryAlertAnalysis {
  return {
    ok: true,
    analyzerVersion: 1,
    sources: [{ sourceId: "runs" }],
    columns: [],
    modes: [],
    unsupported: [],
    errors: [],
    limits: {
      minCadenceSec: 600,
      maxWindowSec: 86_400,
      maxGroups: 500,
      maxMatchRowsPerEval: 200,
      detailRows: 10,
    },
    suggestedName: "failures on runs",
    ...partial,
  };
}

const threshold = (measures: { column: string; type: string; countLike: boolean }[]) =>
  analysis({
    modes: [
      { mode: "threshold", shape: "scalar", measures, groupColumns: [], absenceAllowed: true },
    ],
  });

const WATCHABLE = threshold([{ column: "failures", type: "UInt64", countLike: true }]);
const BLOCKED = analysis({
  ok: false,
  unsupported: [{ mode: "threshold", code: "group_by_time", message: REASON }],
});
const NO_SIGNALS = threshold([]);

let analyzeReply: () => Promise<Response>;
const reply = (a: QueryAlertAnalysis) => async () =>
  new Response(JSON.stringify({ analysis: a, names: {} }));

async function openMenu({
  agent,
  query = QUERY,
  gate = ENABLED,
  title,
  filters,
}: {
  agent: AgentValue | null;
  title?: string;
  filters?: WatchFilters;
  query?: string;
  gate?: Gate;
}) {
  const widget = createElement(QueryWidget, {
    title: "Widget",
    titleString: title,
    query: query || undefined,
    period: "7d",
    watchFilters: filters,
    data: { rows: [], columns: [] },
    config: { type: "table" } as any,
  });
  const page = createElement(
    OperatingSystemContextProvider,
    { platform: "mac" },
    createElement(
      ShortcutsProvider,
      null,
      agent ? createElement(DashboardAgentProvider, { value: agent }, widget) : widget
    )
  );
  const router = createMemoryRouter(
    [
      {
        id: "root",
        path: "/",
        children: [{ id: organizationMatchId, index: true, element: page }],
      },
    ],
    {
      hydrationData: {
        loaderData: {
          root: {
            user: { admin: gate.userAdmin },
            features: { alertsConfigured: gate.alertsConfigured },
          },
          [organizationMatchId]: {
            organization: { id: "org_1" },
            project: { slug: "proj" },
            environment: { slug: "prod" },
            organizations: [
              { id: "org_1", slug: "org", featureFlags: { alertsEnabled: gate.alertsFlag } },
            ],
            isImpersonating: gate.impersonating,
          },
        },
      },
    }
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(RouterProvider, { router })));
  const trigger = container.querySelector<HTMLButtonElement>("button[aria-haspopup=dialog]");
  await act(async () => trigger?.click());
  const items = Array.from(document.body.querySelectorAll<HTMLElement>("[role=dialog] button"));
  return {
    items,
    titles: items.map((b) => b.textContent?.trim()),
    cleanup: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const realFetch = globalThis.fetch;
const calls = { create: [] as unknown[], open: [] as unknown[][], fetch: [] as string[] };
const agent = {
  open: false,
  openCreateAlert: (prefill: unknown) => calls.create.push(prefill),
  openWith: (...args: unknown[]) => calls.open.push(args),
} as unknown as AgentValue;

afterEach(() => {
  document.body.innerHTML = "";
  globalThis.fetch = realFetch;
  calls.create = [];
  calls.open = [];
  calls.fetch = [];
});

describe("QueryWidget Watch menu item", () => {
  const off: Gate = { ...ENABLED, alertsFlag: false, alertsConfigured: true };

  it.each([
    ["no agent context", { agent: null }],
    ["no query", { agent, query: "" }],
    ["alerts disabled", { agent, gate: off }],
    [
      "impersonating without the user's own admin flag",
      { agent, gate: { ...off, impersonating: true } },
    ],
  ])("is hidden with %s", async (_name, options) => {
    // Catches: Watch shown without an agent, a query, or the server's alerts rule.
    const menu = await openMenu(options);
    expect(menu.titles).toContain("Copy CSV");
    expect(menu.titles).not.toContain("Watch");
    menu.cleanup();
  });

  async function clickWatch(times = 1, filters?: WatchFilters, query?: string) {
    globalThis.fetch = (async (url: string) => {
      calls.fetch.push(url);
      return analyzeReply();
    }) as unknown as typeof fetch;
    const menu = await openMenu({ agent, title: "Failed runs", filters, query });
    const watch = menu.items.find((b) => b.textContent?.trim() === "Watch");
    expect(menu.titles.at(-1)).toBe("Watch");
    await act(async () => {
      for (let i = 0; i < times; i++) watch?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    menu.cleanup();
  }

  const created = { source: "query", query: QUERY, period: "7d" };
  const openedText = () => calls.open[0]![0] as string;

  it.each([
    ["watchable", reply(WATCHABLE), true],
    ["the analysis request fails", async () => new Response("{}", { status: 500 }), true],
    ["blocked", reply(BLOCKED), false],
    ["ok but without signal options", reply(NO_SIGNALS), false],
  ])("routes a %s query", async (_name, response, createsAlert) => {
    // Catches: a query that cannot be watched opening the dead-end wizard, or a failed analysis doing nothing.
    analyzeReply = response;
    await clickWatch();
    if (createsAlert) {
      expect(calls.create).toEqual([created]);
      expect(calls.open).toEqual([]);
    } else {
      expect(calls.create).toEqual([]);
      expect(calls.open).toHaveLength(1);
      expect(calls.open[0]!.slice(1)).toEqual([{ newChat: true }]);
      expect(openedText()).toContain(QUERY);
      expect(openedText()).toContain("Period: 7d");
      expect(openedText()).toContain("Chart: Failed runs");
    }
  });

  const taskFilter = activeWatchFilters("project", { taskIdentifiers: ["send-email", "resize"] });

  it("sends a watchable query to the agent when dashboard filters are active", async () => {
    // Catches: an alert created from a filtered dashboard silently dropping the dashboard filters.
    analyzeReply = reply(WATCHABLE);
    await clickWatch(1, taskFilter);
    expect(calls.create).toEqual([]);
    expect(openedText()).toContain("Tasks: send-email, resize");
    expect(openedText()).toContain("Scope: project");
    expect(openedText()).toContain("filters are not part of the query");
  });

  it("opens alert creation for a watchable query without dashboard filters", async () => {
    // Catches: every Watch going through the agent, even with no filters to explain.
    analyzeReply = reply(WATCHABLE);
    await clickWatch(1, activeWatchFilters("environment", { taskIdentifiers: [] }));
    expect(calls.create).toEqual([created]);
    expect(calls.open).toEqual([]);
  });

  it("lists both the reason and the filters for a blocked query", async () => {
    // Catches: the agent message losing either the analyser reason or the filters.
    analyzeReply = reply(BLOCKED);
    await clickWatch(1, taskFilter);
    expect(openedText()).toContain(REASON);
    expect(openedText()).toContain("Tasks: send-email, resize");
  });

  const LONG_QUERY = `SELECT count() AS failures FROM runs WHERE ${"status = 'Failed' OR ".repeat(600)}1`;

  it("shrinks an over-long message for filtered dashboards instead of opening the wizard", async () => {
    // Catches: an over-limit message silently creating an alert on unfiltered data.
    analyzeReply = reply(WATCHABLE);
    await clickWatch(1, taskFilter, LONG_QUERY);
    expect(calls.create).toEqual([]);
    expect(openedText().length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(openedText()).toContain("Tasks: send-email, resize");
    expect(openedText()).toContain("The query was shortened");
  });

  it("still opens alert creation for an over-long query without filters", async () => {
    // Catches: the shrink path being applied when there are no filters to preserve.
    analyzeReply = reply(WATCHABLE);
    await clickWatch(1, undefined, LONG_QUERY);
    expect(calls.open).toEqual([]);
    expect(calls.create).toEqual([{ ...created, query: LONG_QUERY }]);
  });

  it("sends every filter value while the message fits", async () => {
    // Catches: values beyond a fixed cap never reaching the agent, so it applies a partial filter.
    analyzeReply = reply(WATCHABLE);
    const fifty = Array.from({ length: 50 }, (_, i) => `task-${i}`);
    await clickWatch(1, activeWatchFilters("environment", { taskIdentifiers: fifty }));
    expect(openedText()).toContain("task-49");
    expect(openedText()).not.toContain(" more");
  });

  it("shortens the SQL before dropping any filter value", async () => {
    // Catches: filter values being capped while the SQL is what should shrink first.
    analyzeReply = reply(WATCHABLE);
    const fifty = Array.from({ length: 50 }, (_, i) => `task-${i}`);
    await clickWatch(1, activeWatchFilters("environment", { taskIdentifiers: fifty }), LONG_QUERY);
    expect(openedText()).toContain("task-49");
    expect(openedText()).toContain("The query was shortened");
    expect(openedText().length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
  });

  it("caps the lists and says so when the values alone exceed the limit", async () => {
    // Catches: an incomplete filter list being sent without telling the agent to ask for the rest.
    analyzeReply = reply(WATCHABLE);
    const many = Array.from({ length: 2000 }, (_, i) => `task-${i}`);
    await clickWatch(1, activeWatchFilters("environment", { taskIdentifiers: many }));
    expect(openedText().length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(openedText()).not.toContain("task-1999");
    expect(openedText()).toContain("filter lists above are incomplete");
  });

  it("sends one request and one open for a double click while pending", async () => {
    // Catches: a double click starting two analyses and opening the panel twice.
    analyzeReply = reply(WATCHABLE);
    await clickWatch(2);
    expect(calls.fetch).toEqual([ANALYZE_PATH]);
    expect(calls.create).toHaveLength(1);
  });
});
