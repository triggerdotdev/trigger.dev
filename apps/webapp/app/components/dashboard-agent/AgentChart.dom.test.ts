// @vitest-environment jsdom
import type { ChartBlock } from "@internal/dashboard-agent";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { MAX_SVG_ELEMENT_BUDGET } from "~/components/primitives/charts/svgPointBudget";

/**
 * `useOptionalOrganization`/`useOptionalProject`/`useOptionalEnvironment` read route loader data
 * off `useMatches()`, which only resolves inside a real react-router *data* router — the kind
 * Remix's server/browser runtime wires up, not a plain `<MemoryRouter>`. Building one here would
 * mean adding `react-router-dom` as a new direct dependency (today it's only an unresolvable
 * transitive of `@remix-run/react` under pnpm) and hand-assembling a matching route tree, just to
 * hand this chart three ids it otherwise takes as given. Mocked here for the same reason
 * `DraftQuotaPoller.dom.test.ts` mocks `useCurrentPlan` off a route module.
 */
const context = vi.hoisted(() => ({
  organization: { id: "org_1" } as { id: string } | undefined,
  project: { id: "project_1" } as { id: string } | undefined,
  environment: { id: "env_1" } as { id: string } | undefined,
}));
vi.mock("~/hooks/useOrganizations", () => ({
  useOptionalOrganization: () => context.organization,
}));
vi.mock("~/hooks/useProject", () => ({ useOptionalProject: () => context.project }));
vi.mock("~/hooks/useEnvironment", () => ({ useOptionalEnvironment: () => context.environment }));

// jsdom has no ResizeObserver; recharts' ResponsiveContainer needs one to mount at all,
// even while the chart itself is loading or showing the error message below it.
class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// The global `fetch` this jsdom/vitest environment provides is Node's own — it has no notion of
// `window.location` and rejects a relative URL outright. AgentChart calls `fetch("/resources/…")`
// the same way the browser does, so the only fix is to give relative requests an origin; this
// wrapper does no faking of its own; it forwards to the real `fetch`, which then does a real
// network round trip to the `http.createServer` below.
const realFetch = globalThis.fetch;
function fetchAgainstTestServer(input: RequestInfo | URL, init?: RequestInit) {
  const url =
    typeof input === "string" && input.startsWith("/") ? `http://127.0.0.1:3000${input}` : input;
  return realFetch(url, init);
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", StubResizeObserver);
  vi.stubGlobal("fetch", fetchAgainstTestServer);
  // jsdom has no layout engine, so every element's rect is all-zero — recharts' XAxis/YAxis then
  // render no ticks at all (a 0x0 chart isn't worth laying out). Fixing this to a real size is
  // what lets the time-range tests below assert on real rendered tick text instead of computing
  // the expected label independently of what AgentChart actually passed down.
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      width: 800,
      height: 400,
      top: 0,
      left: 0,
      bottom: 400,
      right: 800,
      x: 0,
      y: 0,
      toJSON() {},
    }),
  });
});

const { AgentChart } = await import("./AgentChart");

const block: ChartBlock = {
  type: "chart",
  title: "Failures per hour",
  query: "SELECT timeBucket() AS bucket, count() AS runs FROM runs GROUP BY bucket ORDER BY bucket",
  chartType: "line",
  xAxisColumn: "bucket",
  yAxisColumns: ["runs"],
  period: "24h",
  fillGaps: true,
};

// `label` busts useMetricResourceQuery's module-level response cache (keyed on the query text):
// two tests issuing the identical query would otherwise have the second painted from the
// first's cached response before its own ever lands.
function axisTestBlock(label: string): ChartBlock {
  return {
    ...block,
    query: `${block.query} /* ${label} */`,
  };
}

// No explicit `fillGaps`: the query buckets by time, so the request should still ask for a
// filled series — otherwise one populated bucket among many missing ones draws as a single
// bar/point spanning the whole plot instead of a timeline.
const timeSeriesBlockNoFillGaps: ChartBlock = {
  type: "chart",
  title: "Runs per hour",
  query: "SELECT timeBucket() AS bucket, count() AS runs FROM runs GROUP BY bucket ORDER BY bucket",
  chartType: "bar",
  xAxisColumn: "bucket",
  yAxisColumns: ["runs"],
  period: "24h",
};

// A hand-rolled toStartOfHour() bucket: TSQL's gap-fill only recognizes timeBucket(), so this
// must NOT default to fillGaps even though it looks time-bucketed.
const toStartOfHourBlock: ChartBlock = {
  type: "chart",
  title: "Runs per hour (hand-rolled bucket)",
  query: "SELECT toStartOfHour(created_at) AS bucket, count() AS runs FROM runs",
  chartType: "bar",
  xAxisColumn: "bucket",
  yAxisColumns: ["runs"],
  period: "24h",
};

// Groups by task, so seriesFromRows can cap the plotted series. `label` busts
// useMetricResourceQuery's module-level response cache, which is keyed on the query text — two
// tests issuing the identical query would otherwise have the second one painted from the first's
// cached response before its own ever lands.
function groupedBlock(label: string): ChartBlock {
  return {
    type: "chart",
    title: "Runs by task",
    query: `SELECT timeBucket() AS bucket, task_identifier, count() AS runs FROM runs /* ${label} */ GROUP BY bucket, task_identifier ORDER BY bucket`,
    chartType: "bar",
    xAxisColumn: "bucket",
    yAxisColumns: ["runs"],
    groupByColumn: "task_identifier",
    period: "24h",
  };
}

function manyGroupsRows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    bucket: "2026-01-01 00:00:00",
    task_identifier: `task-${i}`,
    runs: i + 1,
  }));
}

// Three plain series (no groupByColumn), one row per minute — enough buckets that plotting every
// one, unreduced, would blow well past the SVG budget.
function manyBucketsBlock(label: string): ChartBlock {
  return {
    type: "chart",
    title: "Runs per minute",
    query: `SELECT bucket, runs, errors, queued FROM runs /* ${label} */`,
    chartType: "line",
    xAxisColumn: "bucket",
    yAxisColumns: ["runs", "errors", "queued"],
    period: "24h",
  };
}

function manyBucketsRows(count: number) {
  const startMs = Date.parse("2026-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, i) => {
    const bucket = new Date(startMs + i * 60_000).toISOString().slice(0, 19).replace("T", " ");
    return { bucket, runs: i % 50, errors: (i * 3) % 40, queued: (i * 7) % 60 };
  });
}

// Real HTTP server on jsdom's default test origin (http://localhost:3000), so AgentChart's own
// `fetch("/resources/metric", ...)` — unmodified, un-mocked — resolves against real infra
// instead of a canned response.
let server: Server;
let requests: { body: Record<string, unknown> }[] = [];
let pendingResponse: ServerResponse | undefined;
let onRequest: (() => void) | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ body: raw ? JSON.parse(raw) : {} });
      pendingResponse = res;
      onRequest?.();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(3000, "127.0.0.1", () => resolve());
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function waitForRequest(): Promise<{ body: Record<string, unknown> }> {
  const last = requests[requests.length - 1];
  if (last) return Promise.resolve(last);
  return new Promise((resolve) => {
    onRequest = () => resolve(requests[requests.length - 1]!);
  });
}

function respond(body: unknown) {
  const res = pendingResponse;
  if (!res) throw new Error("no request to respond to");
  pendingResponse = undefined;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Polls with real timers (wrapped in `act`) until `check` passes — a real network round trip
 * needs more than a couple of microtask ticks to land. */
async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    // eslint-disable-next-line no-await-in-loop -- polling is the point
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function waitForXAxisTicks(): Promise<Element[]> {
  let ticks: Element[] = [];
  await waitFor(() => {
    ticks = [...container!.querySelectorAll(".recharts-xAxis text")];
    return ticks.length > 0;
  });
  return ticks;
}

let container: HTMLDivElement | undefined;
let root: Root | undefined;

function render(renderedBlock: ChartBlock = block) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(
        OperatingSystemContextProvider,
        { platform: "mac" },
        createElement(ShortcutsProvider, null, createElement(AgentChart, { block: renderedBlock }))
      )
    );
  });
}

beforeEach(() => {
  requests = [];
  onRequest = undefined;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  // A test that never answers its own request would otherwise leave the socket open and hang
  // this file's final `server.close()`.
  if (pendingResponse && !pendingResponse.writableEnded) {
    respond({ success: false, error: "unanswered in test" });
  }
  context.organization = { id: "org_1" };
  context.project = { id: "project_1" };
  context.environment = { id: "env_1" };
  vi.unstubAllGlobals();
});

describe("AgentChart", () => {
  it("marks the request as user-authored and forwards fillGaps", async () => {
    render();
    const request = await waitForRequest();

    expect(request.body).toMatchObject({ userAuthoredQuery: true, fillGaps: true });
  });

  it("shows a query-failure message, not the generic filter-mismatch copy", async () => {
    render();
    await waitForRequest();
    respond({ success: false, error: "ClickHouse says no" });

    await waitFor(() => !!container!.textContent?.includes("This chart's query couldn't run."));
  });

  it("shows a missing-context message instead of fetching", () => {
    context.environment = undefined;
    render();

    expect(requests).toHaveLength(0);
    expect(container!.textContent).toContain("No environment context");
  });

  it("renders the tools menu trigger in the card header", () => {
    render();

    expect(container!.querySelector('[aria-label="More actions"]')).not.toBeNull();
  });

  it("defaults fillGaps to true for a timeBucket() query with no explicit setting", async () => {
    render(timeSeriesBlockNoFillGaps);
    const request = await waitForRequest();

    expect(request.body).toMatchObject({ fillGaps: true });
  });

  it("does not default fillGaps for a hand-rolled toStartOfHour() bucket", async () => {
    render(toStartOfHourBlock);
    const request = await waitForRequest();

    // TSQL's gap-fill only recognizes timeBucket(); defaulting fillGaps here would be a silent
    // no-op that leaves the caller thinking gaps are filled when they aren't.
    expect(request.body).toMatchObject({ fillGaps: false });
  });

  it("renders date-style x-axis ticks when the server's timeRange spans multiple days", async () => {
    render(axisTestBlock("multi-day"));
    await waitForRequest();
    respond({
      success: true,
      data: {
        rows: [{ bucket: "2026-01-01 00:00:00", runs: 3 }],
        timeRange: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-08T00:00:00.000Z" },
      },
    });

    // Read the rendered tick text off the real chart, not a label computed independently from
    // the same from/to — deleting the `timeRange` prop AgentChart passes down must fail this.
    const xAxisTicks = await waitForXAxisTicks();
    for (const tick of xAxisTicks) {
      expect(tick.textContent).toMatch(/^[A-Za-z]{3}\s?\d{1,2}$/);
      expect(tick.textContent).not.toMatch(/:/);
    }
  });

  it("renders clock-style x-axis ticks for a single point with no server timeRange", async () => {
    render(axisTestBlock("single-point"));
    await waitForRequest();
    // No usable `timeRange` on the response (blank, unlike the real route): AgentChart's
    // `Date.parse` fails, so MetricChart falls back to deriving the range from the data itself —
    // one point has none, so it reads as same-day and ticks clock-style, not date-style.
    respond({
      success: true,
      data: {
        rows: [{ bucket: "2026-01-01 00:00:00", runs: 3 }],
        timeRange: { from: "", to: "" },
      },
    });

    const xAxisTicks = await waitForXAxisTicks();
    for (const tick of xAxisTicks) {
      expect(tick.textContent).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it("keeps the fullscreen tools menu trigger always visible, not hover-revealed", () => {
    render();

    const maximizeButton = container!.querySelector<HTMLButtonElement>(
      '[aria-label="Maximize chart"]'
    );
    expect(maximizeButton).not.toBeNull();
    act(() => {
      maximizeButton!.click();
    });

    // The dialog portals to document.body, outside `container`, so the card's own
    // hover-revealed trigger and the dialog's always-visible one are two separate elements.
    const triggers = document.querySelectorAll('[aria-label="More actions"]');
    const dialogTrigger = [...triggers].find((el) => !container!.contains(el));
    expect(dialogTrigger).toBeTruthy();
    expect(dialogTrigger!.className).not.toContain("opacity-0");
  });

  it("notes a series truncation past MAX_SERIES groups, instead of dropping them silently", async () => {
    render(groupedBlock("over-cap"));
    await waitForRequest();
    respond({
      success: true,
      data: {
        rows: manyGroupsRows(60),
        timeRange: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
      },
    });

    await waitFor(() => !!container!.textContent?.includes("Showing"));
    expect(container!.textContent).toContain("Showing 50 of 60 series");
  });

  it("shows no truncation notice under the cap", async () => {
    render(groupedBlock("under-cap"));
    await waitForRequest();
    respond({
      success: true,
      data: {
        rows: manyGroupsRows(3),
        timeRange: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
      },
    });

    await waitFor(() => container!.textContent !== "");
    expect(container!.textContent).not.toContain("Showing");
  });

  it("keeps rendered dot count within the SVG budget for a large bucket count", async () => {
    render(manyBucketsBlock("many-buckets"));
    await waitForRequest();
    respond({
      success: true,
      data: {
        rows: manyBucketsRows(3000),
        timeRange: { from: "2026-01-01T00:00:00.000Z", to: "2026-01-03T02:00:00.000Z" },
      },
    });

    let dots: Element[] = [];
    await waitFor(() => {
      dots = [...container!.querySelectorAll(".recharts-dot")];
      return dots.length > 0;
    });

    // Undownsampled this would be 3000 buckets x 3 series = 9000 dots, well past the budget.
    expect(dots.length).toBeLessThanOrEqual(MAX_SVG_ELEMENT_BUDGET);
    expect(dots.length).toBeLessThan(3000 * 3);
  });
});
