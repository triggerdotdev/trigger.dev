// @vitest-environment jsdom
import type * as RemixReactModule from "@remix-run/react";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { QueryAlertAnalysis } from "~/v3/services/alerts/queryAlerts/analyzeQueryForAlert.server";
import { DashboardAgentProvider } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { decodeQueryParam } from "./queryAlertLink";
import { WatchQueryButton } from "./WatchQueryButton";

vi.mock("@remix-run/react", async (importOriginal) => ({
  ...(await importOriginal<typeof RemixReactModule>()),
  Link: ({ to, children }: { to: string; children: ReactNode }) =>
    createElement("a", { href: to }, children),
}));

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const LIMITS = {
  minCadenceSec: 600,
  maxWindowSec: 86_400,
  maxGroups: 500,
  maxMatchRowsPerEval: 200,
  detailRows: 10,
};

function analysis(partial: Partial<QueryAlertAnalysis>): QueryAlertAnalysis {
  return {
    ok: true,
    analyzerVersion: 1,
    sources: [{ sourceId: "runs" }],
    columns: [],
    modes: [],
    unsupported: [],
    errors: [],
    limits: LIMITS,
    suggestedName: "failures on runs",
    ...partial,
  };
}

const THRESHOLD = analysis({
  modes: [
    {
      mode: "threshold",
      shape: "scalar",
      measures: [{ column: "failures", type: "UInt64", countLike: true }],
      groupColumns: [],
      absenceAllowed: true,
    },
  ],
});

let container: HTMLElement;
let root: Root;

function render(
  props: ComponentProps<typeof WatchQueryButton>,
  agent?: ComponentProps<typeof DashboardAgentProvider>["value"]
) {
  act(() =>
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(
          ShortcutsProvider,
          null,
          createElement(
            DashboardAgentProvider,
            { value: agent ?? null },
            createElement(WatchQueryButton, props)
          )
        )
      )
    )
  );
}

describe("WatchQueryButton", () => {
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders nothing before the query has been run", () => {
    render({ alertsPath: "/alerts", period: "7d", watch: undefined });
    expect(container.textContent).toBe("");
  });

  it("renders nothing when the analysis is ok but has no modes", () => {
    render({
      alertsPath: "/alerts",
      period: "7d",
      watch: { query: "SELECT 1", analysis: analysis({}) },
    });
    expect(container.textContent).toBe("");
  });

  it("links to the alerts page with the query as base64url (catches dropped encoding)", () => {
    const query = "SELECT count() AS failures FROM runs WHERE status = 'Failed' -- ü?/+";
    render({ alertsPath: "/alerts", period: "1h", watch: { query, analysis: THRESHOLD } });
    const href = container.querySelector("a")!.getAttribute("href")!;
    expect(container.querySelector("a")!.textContent).toBe("Watch");
    expect(container.querySelector("[data-testid=watch-query] a")).not.toBeNull();
    expect(container.querySelector("a svg")).not.toBeNull();
    const params = new URL(href, "http://localhost").searchParams;
    expect(params.get("create")).toBe("1");
    expect(params.get("source")).toBe("query");
    expect(params.get("qperiod")).toBe("1h");
    expect(params.has("period")).toBe(false);
    expect(params.get("mode")).toBe("threshold");
    expect(params.get("measure")).toBe("failures");
    const q = params.get("q")!;
    expect(q).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeQueryParam(q)).toBe(query);
  });

  it("opens the agent with the query prefill instead of navigating when the agent is on", () => {
    const openCreateAlert = vi.fn();
    const query = "SELECT count() AS failures FROM runs";
    render({ alertsPath: "/alerts", period: "1h", watch: { query, analysis: THRESHOLD } }, {
      openCreateAlert,
    } as unknown as ComponentProps<typeof DashboardAgentProvider>["value"]);
    expect(container.querySelector("a")).toBeNull();
    const button = container.querySelector<HTMLButtonElement>("[data-testid=watch-query] button")!;
    expect(button.textContent).toBe("Watch");
    act(() => button.click());
    expect(openCreateAlert).toHaveBeenCalledWith({
      source: "query",
      query,
      period: "1h",
      mode: "threshold",
      measure: "failures",
    });
  });

  it("does not submit the surrounding query form when opening the agent", () => {
    const openCreateAlert = vi.fn();
    const onSubmit = vi.fn((e: Event) => e.preventDefault());
    const form = document.createElement("form");
    form.addEventListener("submit", onSubmit);
    document.body.appendChild(form);
    form.appendChild(container);
    render(
      {
        alertsPath: "/alerts",
        period: "1h",
        watch: { query: "SELECT count() AS failures FROM runs", analysis: THRESHOLD },
      },
      { openCreateAlert } as unknown as ComponentProps<typeof DashboardAgentProvider>["value"]
    );
    act(() => form.querySelector<HTMLButtonElement>("button")!.click());
    expect(openCreateAlert).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    form.remove();
  });

  it("renders nothing when the encoded query exceeds 8 KB even though it has fewer characters", () => {
    const query = `SELECT count() AS failures FROM runs -- ${"é".repeat(3500)}`;
    expect(query.length).toBeLessThan(8192);
    render({ alertsPath: "/alerts", period: "1h", watch: { query, analysis: THRESHOLD } });
    expect(container.textContent).toBe("");
  });

  it("renders nothing when the analysis failed", () => {
    render({ alertsPath: "/alerts", period: "1h", watch: { query: "SELECT 1", analysis: null } });
    expect(container.textContent).toBe("");
  });
});
