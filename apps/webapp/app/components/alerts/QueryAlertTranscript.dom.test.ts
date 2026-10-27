// @vitest-environment jsdom
import { EyeIcon } from "@heroicons/react/20/solid";
import type * as RemixReactModule from "@remix-run/react";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, useState, type ComponentProps, type ReactNode } from "react";
import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import type { QueryAlertAnalysis } from "~/v3/services/alerts/queryAlerts/analyzeQueryForAlert.server";
import { QueryAlertTranscript, type QueryWatchPrefill } from "./QueryAlertTranscript";

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

const ANALYZE_PATH = "/resources/orgs/org/projects/proj/env/prod/alerts/analyze-query";
const PREVIEW_PATH = "/resources/orgs/org/projects/proj/env/prod/alerts/preview-query";
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
const MATCH = {
  mode: "match" as const,
  sourceId: "runs",
  rowIdColumn: "run_id",
  eventColumn: "created_at",
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

function thresholdAnalysis(measures = [FAILURES]) {
  return analysis({
    modes: [
      { mode: "threshold", shape: "scalar", measures, groupColumns: [], absenceAllowed: true },
    ],
  });
}

const NAMES = {
  "threshold:failures": "failures on runs",
  "absence:failures": "No failures on runs",
  "threshold:took": "took on runs",
  "match:": "New runs rows",
};

let analyzed: QueryAlertAnalysis = thresholdAnalysis();
const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
  if (String(url) === ANALYZE_PATH) {
    return new Response(JSON.stringify({ analysis: analyzed, names: NAMES }));
  }
  if (String(url) === "/resources/alerts/create") {
    return new Response(JSON.stringify({ ok: true, alertId: "a1" }));
  }
  if (String(url) === PREVIEW_PATH) {
    return new Response(
      JSON.stringify({
        ok: true,
        mode: "threshold",
        value: 7,
        wouldFire: true,
        window: { minutes: 60, from: "", to: "" },
      })
    );
  }
  return new Response("{}");
});

Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

let container: HTMLElement;
let root: Root;

async function mount(
  prefill: Partial<QueryWatchPrefill> = {},
  chat?: ComponentProps<typeof QueryAlertTranscript>["chat"]
) {
  await act(async () =>
    root.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" } as ComponentProps<typeof OperatingSystemContextProvider>,
        createElement(
          ShortcutsProvider,
          null,
          createElement(QueryAlertTranscript, {
            prefill: { query: QUERY, period: "1h", ...prefill },
            alertDetailPath: (id: string) => `/alerts/${id}`,
            environmentTitle: "Production",
            chat,
          })
        )
      )
    )
  );
}

const card = () => document.querySelector<HTMLElement>("[role=dialog]");
const question = () => card()?.getAttribute("aria-label");
const rows = () =>
  Array.from(card()!.querySelectorAll<HTMLButtonElement>("li button")).map((b) => b.textContent);
const row = (label: string) => {
  const found = Array.from(card()!.querySelectorAll<HTMLButtonElement>("li button")).find(
    (b) => b.textContent === label
  );
  if (!found) throw new Error(`no ${label}: ${rows()}`);
  return found;
};
const choose = (label: string) => act(() => row(label).click());
const button = (label: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === label
  )!;
function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const input = (label: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;

describe("QueryAlertTranscript", () => {
  beforeEach(() => {
    analyzed = thresholdAnalysis();
    fetchMock.mockClear();
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

  it("analyzes on the server and opens on a read-only Query step", async () => {
    await mount();
    const call = fetchMock.mock.calls.find(([url]) => url === ANALYZE_PATH)!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ query: QUERY });
    expect(question()).toBe("Watch this query?");
    expect(card()!.querySelector("[data-testid=query-alert-query]")!.textContent).toBe(QUERY);
    expect(card()!.querySelector("input, textarea")).toBeNull();
    const block = card()!.querySelector("[data-testid=query-alert-query]")!;
    const keywords = Array.from(block.querySelectorAll(".token.keyword")).map((t) => t.textContent);
    expect(keywords).toEqual(expect.arrayContaining(["SELECT", "AS", "FROM"]));
    expect(block.querySelector("button")).toBeNull();
  });

  it("skips Signal with one choice and asks for it with two", async () => {
    await mount();
    choose("Continue");
    expect(question()).toBe("When should it fire?");

    act(() => root.unmount());
    root = createRoot(container);
    analyzed = thresholdAnalysis([FAILURES, TOOK]);
    await mount();
    choose("Continue");
    expect(question()).toBe("Which value should it watch?");
    expect(rows()).toEqual(["failures", "took"]);
  });

  it("has no Window step in match mode", async () => {
    analyzed = analysis({ modes: [MATCH] });
    await mount();
    choose("Continue");
    expect(rows()).toEqual(["New matching results appear"]);
    choose("New matching results appear");
    expect(question()).toBe("How long should it stay active?");
  });

  it("shows the analyzer messages and no steps when nothing is supported", async () => {
    analyzed = analysis({
      ok: false,
      unsupported: [
        { mode: "match", code: "limit", message: "Remove LIMIT to watch new rows." },
        { mode: "threshold", code: "no_measure", message: "Threshold alerts need a number." },
      ],
    });
    await mount();
    expect(card()).toBeNull();
    const unavailable = document.querySelector("[data-testid=query-alert-unavailable]")!;
    expect(unavailable.textContent).toContain("Remove LIMIT to watch new rows.");
    expect(unavailable.textContent).toContain("Threshold alerts need a number.");
  });

  it("reviews, previews and creates with the query and the signal choice", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-01-01T00:00:00.000Z") });
    try {
      analyzed = thresholdAnalysis([FAILURES, TOOK]);
      await mount();
      choose("Continue");
      choose("took");
      choose("Value crosses a threshold");
      type(input("Threshold"), "5");
      choose("Below");
      expect(question()).toBe("Over what window?");
      expect(input("Window").value).toBe("60");
      choose("Continue");
      choose("For 24 hours");
      choose("Ops webhook");
      act(() => button("Continue").click());
      expect(question()).toBe("What should it be called?");
      expect(input("Name").value).toBe("took on runs");
      choose("Continue");

      expect(card()).toBeNull();
      const review = document.querySelector("[data-testid=query-alert-review]")!;
      expect(review.querySelector("[data-testid=query-alert-query]")!.textContent).toBe(QUERY);
      expect(review.textContent).toContain("took < 5 for 60m");
      expect(review.textContent).toContain("Watch");
      expect(review.textContent).toContain("Production · Custom query · Recurring");
      expect(review.textContent).toContain("Notify: Ops webhook");
      const eye = renderToStaticMarkup(createElement(EyeIcon)).match(/ d="([^"]+)"/)![1];
      expect(review.querySelector("svg path")!.getAttribute("d")).toBe(eye);
      expect(Array.from(review.querySelectorAll("button")).map((b) => b.textContent)).toEqual([
        "Create alert",
        "Preview",
        "Customize",
        "Start over",
      ]);

      await act(async () => button("Preview").click());
      const preview = fetchMock.mock.calls.find(([url]) => url === PREVIEW_PATH)!;
      expect(JSON.parse(preview[1]!.body as string)).toEqual({
        query: QUERY,
        mode: "threshold",
        measure: "took",
        windowMinutes: 60,
        threshold: 5,
        operator: "<",
      });
      expect(review.textContent).toContain("Current value: 7");

      await act(async () => button("Create alert").click());
      const calls = fetchMock.mock.calls.filter(([url]) => url === "/resources/alerts/create");
      expect(calls).toHaveLength(1);
      expect(JSON.parse(calls[0]![1]!.body as string)).toEqual({
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
          windowMinutes: 60,
          query: QUERY,
          querySignalChoice: { mode: "threshold", measure: "took" },
          expiresAt: "2026-01-02T00:00:00.000Z",
          notifierChannelIds: ["ch1"],
        },
      });
      expect(document.querySelector("[data-testid=query-alert-review]")).toBeNull();
      const created = document.querySelector("[data-testid=alert-created]")!;
      expect(created.textContent).toContain("took on runs is active.");
      expect(created.textContent).toContain("It expires in 24h.");
      expect(created.textContent).toContain("took < 5 for 60m · Production · Custom query");
      expect(created.textContent).toContain("Notifying: Ops webhook.");
      expect(created.textContent).toContain("It's at the top of your alerts list.");
      const view = Array.from(created.querySelectorAll("a")).find(
        (a) => a.textContent === "View alert"
      )!;
      expect(view.getAttribute("href")).toBe("/alerts/a1");
    } finally {
      vi.useRealTimers();
    }
  });

  async function reachReview() {
    choose("Continue");
    choose("Value crosses a threshold");
    type(input("Threshold"), "5");
    choose("Above");
    choose("Continue");
    choose("For 24 hours");
  }

  it("keeps the agent-suggested threshold and window", async () => {
    await mount({ operator: ">", value: 42, windowSec: 601 });
    choose("Continue");
    choose("Value crosses a threshold");
    expect(input("Threshold").value).toBe("42");
    expect(row("Above").querySelector('[aria-label="Selected"]')).not.toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>('button[aria-label="Next question"]')!.disabled
    ).toBe(false);
    choose("Above");
    expect(input("Window").value).toBe("11");
  });

  it("offers This chat in the agent, preselected, and sends the chat ids", async () => {
    const release = vi.fn();
    await mount({}, { chatId: "chat_on_use", ensure: async () => ({ chatId: "chat_1", release }) });
    reachReview();
    expect(rows()).toContain("This chat");
    act(() => button("Continue").click());
    choose("Continue");
    await act(async () => button("Create alert").click());
    const call = fetchMock.mock.calls.find(([url]) => url === "/resources/alerts/create")!;
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({
      chatNotifier: "on",
      chatId: "chat_1",
      transcriptChatId: "chat_1",
      form: { notifierChannelIds: [] },
    });
    expect(release).not.toHaveBeenCalled();
  });

  it("keeps transcriptChatId when only a channel is chosen", async () => {
    await mount({}, { chatId: "chat_on_use", ensure: async () => ({ chatId: "chat_1" }) });
    reachReview();
    choose("This chat");
    choose("Ops webhook");
    act(() => button("Continue").click());
    choose("Continue");
    await act(async () => button("Create alert").click());
    const call = fetchMock.mock.calls.find(([url]) => url === "/resources/alerts/create")!;
    const body = JSON.parse(call[1]!.body as string);
    expect(body).toMatchObject({
      transcriptChatId: "chat_1",
      form: { notifierChannelIds: ["ch1"] },
    });
    expect(body.chatNotifier).toBeUndefined();
    expect(body.chatId).toBeUndefined();
  });

  it("offers no This chat in the manual dock", async () => {
    await mount();
    reachReview();
    expect(rows()).not.toContain("This chat");
  });
});
