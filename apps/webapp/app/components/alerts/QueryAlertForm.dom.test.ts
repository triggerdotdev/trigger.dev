// @vitest-environment jsdom
import type * as RemixReactModule from "@remix-run/react";
import { createElement, useState, type ComponentProps, type ReactNode } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { QueryAlertAnalysis } from "~/v3/services/alerts/queryAlerts/analyzeQueryForAlert.server";
import { ManualAlertCreationDock } from "./ManualAlertCreation";
import type { QueryAlertPrefill } from "./queryAlertLink";

vi.mock("@remix-run/react", async (importOriginal) => ({
  ...(await importOriginal<typeof RemixReactModule>()),
  useInRouterContext: () => false,
  Link: ({ to, children }: { to: string; children: ReactNode }) =>
    createElement("a", { href: to }, children),
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/", search: "" }),
  useFetcher: () => {
    const [url, setUrl] = useState<string>();
    return {
      data: url?.startsWith("/resources/alerts/channels")
        ? { channels: [{ id: "ch1", name: "Ops webhook", type: "WEBHOOK" }], canWrite: true }
        : undefined,
      load: setUrl,
    };
  },
}));
vi.mock("~/hooks/useOrganizations", () => ({
  useOptionalOrganization: () => ({ slug: "org", id: "org1" }),
  useOrganization: () => ({ slug: "org", id: "org1" }),
}));
vi.mock("~/hooks/useProject", () => ({
  useOptionalProject: () => ({ slug: "proj", id: "proj1" }),
  useProject: () => ({ slug: "proj", id: "proj1" }),
}));
vi.mock("~/hooks/useEnvironment", () => ({
  useOptionalEnvironment: () => ({ slug: "prod", id: "env1", type: "PRODUCTION" }),
  useEnvironment: () => ({ slug: "prod", id: "env1", type: "PRODUCTION" }),
}));
vi.mock("~/hooks/useTypedMatchData", () => ({ useTypedMatchesData: () => undefined }));
vi.mock("~/hooks/useFeatures", () => ({ useFeatures: () => ({ queueMetricsEnabled: true }) }));

const PREVIEW_PATH = "/resources/orgs/org/projects/proj/env/prod/alerts/preview-query";
let previewResponse = () => new Response("{}");
let createResponse = () => new Response(JSON.stringify({ ok: true, alertId: "a1" }));
const fetchMock = vi.fn(async (url: string | URL | Request) => {
  if (String(url) === "/resources/alerts/create") return createResponse();
  if (String(url) === PREVIEW_PATH) return previewResponse();
  return new Response("{}");
});

Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const QUERY = "SELECT count() AS failures, avg(duration) AS took FROM runs";
const LIMITS = {
  minCadenceSec: 600,
  maxWindowSec: 86_400,
  maxGroups: 500,
  maxMatchRowsPerEval: 200,
  detailRows: 10,
};
const FAILURES = { column: "failures", type: "UInt64", countLike: true };
const TOOK = { column: "took", type: "Float64", countLike: false };

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

function thresholdAnalysis(measures = [FAILURES], absenceAllowed = true) {
  return analysis({
    modes: [{ mode: "threshold", shape: "scalar", measures, groupColumns: [], absenceAllowed }],
  });
}

function prefill(partial: Partial<QueryAlertPrefill> = {}): QueryAlertPrefill {
  return {
    query: QUERY,
    period: "7d",
    analysis: thresholdAnalysis(),
    names: {
      "threshold:failures": "failures on runs",
      "absence:failures": "No failures on runs",
      "threshold:took": "took on runs",
    },
    ...partial,
  };
}

const fieldset = (step: string) =>
  document.querySelector<HTMLFieldSetElement>(`fieldset[data-step="${step}"]`);
const combobox = (step: string, label?: string) =>
  Array.from(
    fieldset(step)?.querySelectorAll<HTMLButtonElement>("button[role=combobox]") ?? []
  ).find((b) => !label || b.getAttribute("aria-label") === label) ?? null;
const popover = (select: HTMLElement) =>
  document.getElementById(select.getAttribute("aria-controls") ?? "");
const options = (select: HTMLElement) =>
  Array.from(popover(select)?.querySelectorAll<HTMLElement>("[role=option]") ?? []);
const click = (el: HTMLElement) => act(() => el.click());
function openSelect(select: HTMLElement) {
  act(() => select.focus());
  act(() => select.click());
}
function optionLabels(step: string, label?: string) {
  const select = combobox(step, label)!;
  openSelect(select);
  const labels = options(select).map((o) => o.textContent);
  act(() => select.click());
  return labels;
}
function pick(step: string, label: string, aria?: string) {
  const select = combobox(step, aria)!;
  openSelect(select);
  const found = options(select).find((o) => o.textContent === label);
  if (!found) throw new Error(`no ${label}: ${options(select).map((o) => o.textContent)}`);
  click(found);
}
const checkbox = (step: string, label: string) =>
  Array.from(fieldset(step)!.querySelectorAll<HTMLLabelElement>("[data-checkbox-list] label"))
    .find((l) => l.textContent === label)!
    .querySelector<HTMLInputElement>("input")!;
const button = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === label
  );
const input = (label: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

let container: HTMLElement;
let root: Root;
const onCreated = vi.fn();

function render(queryPrefill: QueryAlertPrefill) {
  act(() =>
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(
          ShortcutsProvider,
          null,
          createElement(
            ManualAlertCreationDock,
            {
              open: true,
              prefill: {},
              queryPrefill,
              alertDetailPath: (id: string) => `/alerts/${id}`,
              onCreated,
              onClose: vi.fn(),
            },
            createElement("div", { "data-testid": "page" }, "page")
          )
        )
      )
    )
  );
}

describe("QueryAlertForm", () => {
  beforeEach(() => {
    fetchMock.mockClear();
    onCreated.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows the query read-only as the first section", () => {
    render(prefill());
    const form = document.querySelector("[data-testid=query-alert-form]")!;
    const first = form.firstElementChild as HTMLElement;
    expect(first.getAttribute("data-step")).toBe("query");
    expect(first.querySelector("[data-testid=query-alert-query]")!.textContent).toBe(QUERY);
    expect(first.querySelector("input, textarea")).toBeNull();
  });

  it("hides Signal with one measure and shows it with two measures or two modes", () => {
    render(prefill());
    expect(document.querySelector("[data-testid=query-alert-form]")).not.toBeNull();
    expect(fieldset("signal")).toBeNull();

    render(prefill({ query: `${QUERY} `, analysis: thresholdAnalysis([FAILURES, TOOK]) }));
    expect(optionLabels("signal")).toEqual(["failures", "took"]);

    render(
      prefill({
        query: `${QUERY}  `,
        analysis: analysis({
          modes: [
            ...thresholdAnalysis().modes,
            { mode: "match", sourceId: "runs", rowIdColumn: "run_id", eventColumn: "created_at" },
          ],
        }),
      })
    );
    expect(optionLabels("signal")).toEqual(["failures", "New runs rows"]);
  });

  it("offers the absence condition only when the analysis allows it", () => {
    render(prefill());
    expect(optionLabels("condition", "Condition")).toEqual([
      "Value crosses a threshold",
      "No matching results for the window",
    ]);

    render(prefill({ query: `${QUERY} `, analysis: thresholdAnalysis([FAILURES], false) }));
    expect(combobox("condition", "Condition")).toBeNull();
    expect(fieldset("condition")!.textContent).toContain("Value crosses a threshold");
    expect(fieldset("condition")!.textContent).not.toContain("No matching results");
  });

  it("defaults the window to min(period, 24h) floored at the minimum cadence (catches a removed floor)", () => {
    render(prefill({ period: "5m" }));
    expect(input("Window").value).toBe("10");
    expect(fieldset("window")!.textContent).toContain("At least 10 min, at most 1440 min.");

    render(prefill({ query: `${QUERY} `, period: "7d" }));
    expect(input("Window").value).toBe("1440");

    render(prefill({ query: `${QUERY}  `, period: "30m" }));
    expect(input("Window").value).toBe("30");
  });

  it("caps the default window at the analysis max window (catches a removed cap)", () => {
    render(
      prefill({
        analysis: { ...thresholdAnalysis(), limits: { ...LIMITS, maxWindowSec: 3600 } },
      })
    );
    expect(input("Window").value).toBe("60");
    expect(fieldset("window")!.textContent).toContain("at most 60 min.");
  });

  it.each([400, 422, 500])("shows the server error on a %i create response", async (status) => {
    const message = "Quiet window must be at least 600 seconds";
    createResponse = () => new Response(JSON.stringify({ error: message }), { status });
    try {
      render(prefill());
      type(input("Threshold"), "3");
      pick("expiry", "For 24 hours");
      click(checkbox("notifiers", "Ops webhook"));
      await act(async () => button("Create alert")!.click());
      expect(document.body.textContent).toContain(
        status === 500 ? "Failed to create the alert. Try again." : message
      );
      expect(onCreated).not.toHaveBeenCalled();
    } finally {
      createResponse = () => new Response(JSON.stringify({ ok: true, alertId: "a1" }));
    }
  });

  it("has no Window in match mode and previews with the default lookback", async () => {
    render(
      prefill({
        period: "2h",
        analysis: analysis({
          modes: [
            { mode: "match", sourceId: "runs", rowIdColumn: "run_id", eventColumn: "created_at" },
          ],
        }),
      })
    );
    expect(fieldset("condition")!.textContent).toContain("New matching results appear");
    expect(fieldset("window")).toBeNull();
    previewResponse = () =>
      new Response(JSON.stringify({ ok: false, reason: "The query could not be evaluated." }));
    await act(async () => button("Preview")!.click());
    const call = fetchMock.mock.calls.find(([url]) => url === PREVIEW_PATH)!;
    expect(JSON.parse((call as unknown as [string, RequestInit])[1].body as string)).toEqual({
      query: QUERY,
      mode: "match",
      windowMinutes: 120,
    });
    expect(document.body.textContent).toContain("The query could not be evaluated.");
  });

  it("blocks Create until the threshold is a number", () => {
    render(prefill());
    pick("expiry", "For 24 hours");
    click(checkbox("notifiers", "Ops webhook"));
    expect(button("Create alert")!.disabled).toBe(true);
    type(input("Threshold"), "abc");
    expect(button("Create alert")!.disabled).toBe(true);
    type(input("Threshold"), "3");
    expect(button("Create alert")!.disabled).toBe(false);
  });

  it("has no Frequency control", () => {
    render(
      prefill({
        analysis: analysis({
          modes: [
            ...thresholdAnalysis([FAILURES, TOOK]).modes,
            { mode: "match", sourceId: "runs", rowIdColumn: "run_id", eventColumn: "created_at" },
          ],
        }),
      })
    );
    const panel = document.querySelector("[data-testid=manual-alert-panel]")!;
    expect(panel.textContent).not.toMatch(/frequency/i);
  });

  it("posts the query and the signal choice and reports the created id", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00.000Z") });
    try {
      render(prefill({ analysis: thresholdAnalysis([FAILURES, TOOK]) }));
      pick("signal", "took");
      expect(input("Name").value).toBe("took on runs");
      type(input("Threshold"), "5");
      pick("condition", "<", "Operator");
      pick("expiry", "For 24 hours");
      click(checkbox("notifiers", "Ops webhook"));
      await act(async () => button("Create alert")!.click());
      const calls = fetchMock.mock.calls.filter(([url]) => url === "/resources/alerts/create");
      expect(calls).toHaveLength(1);
      expect(JSON.parse((calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
        organizationId: "org1",
        projectId: "proj1",
        environmentId: "env1",
        name: "took on runs",
        expiry: "24h",
        form: {
          capabilityKey: "custom.query",
          scopeType: "all",
          conditionKind: "threshold",
          operator: "<",
          value: 5,
          windowMinutes: 1440,
          query: QUERY,
          querySignalChoice: { mode: "threshold", measure: "took" },
          expiresAt: "2026-01-02T00:00:00.000Z",
          notifierChannelIds: ["ch1"],
        },
      });
      expect(onCreated).toHaveBeenCalledWith("a1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an edited name when the signal changes", () => {
    render(prefill({ analysis: thresholdAnalysis([FAILURES, TOOK]) }));
    expect(input("Name").value).toBe("failures on runs");
    type(input("Name"), "My alert");
    pick("signal", "took");
    expect(input("Name").value).toBe("My alert");
  });

  it("previews the alert and reports a busy lane", async () => {
    render(prefill());
    pick("condition", "No matching results for the window", "Condition");
    previewResponse = () =>
      new Response(
        JSON.stringify({
          ok: true,
          mode: "absence",
          value: 0,
          wouldFire: true,
          window: { minutes: 1440, from: "", to: "" },
        })
      );
    await act(async () => button("Preview")!.click());
    const call = fetchMock.mock.calls.find(([url]) => url === PREVIEW_PATH)!;
    expect(JSON.parse((call as unknown as [string, RequestInit])[1].body as string)).toEqual({
      query: QUERY,
      mode: "absence",
      measure: "failures",
      windowMinutes: 1440,
    });
    expect(document.body.textContent).toContain("Matching rows in the window: 0");
    expect(document.body.textContent).toContain("Would fire now");

    previewResponse = () => new Response(JSON.stringify({ error: "busy" }), { status: 429 });
    type(input("Window"), "60");
    await act(async () => button("Preview")!.click());
    expect(document.body.textContent).toContain("Another query is running, try again");
  });

  it("shows the analyzer messages and a way back when the query has no alert mode", () => {
    render(
      prefill({
        analysis: analysis({
          ok: false,
          errors: [{ code: "parse_error", message: "Syntax error near FROM." }],
        }),
      })
    );
    expect(document.querySelector("[data-testid=query-alert-form]")).toBeNull();
    const unavailable = document.querySelector("[data-testid=query-alert-unavailable]")!;
    expect(unavailable.textContent).toContain("Syntax error near FROM.");
    expect(unavailable.textContent).not.toContain("parse_error");
    const back = Array.from(unavailable.querySelectorAll("a")).find(
      (a) => a.textContent === "Back to query"
    )!;
    expect(back.getAttribute("href")).toBe("/orgs/org/projects/proj/env/prod/query");
  });
});
