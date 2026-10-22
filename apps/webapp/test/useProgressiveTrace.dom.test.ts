// @vitest-environment jsdom
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useProgressiveTrace, type ProgressiveTraceInput } from "~/hooks/useProgressiveTrace";

type Request = { path: string; params: URLSearchParams; at: number };
type Handler = (request: Request) => Promise<unknown> | unknown;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FAIL = Symbol("fail");

const T0 = new Date("2026-10-06T10:00:00.000Z").getTime();

let server: Server;
let baseUrl: string;
let requests: Request[];
let handler: Handler;
let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(async () => {
  requests = [];
  handler = () => ({ events: [], nextCursor: null, hasMore: false });
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const request = { path: url.pathname, params: url.searchParams, at: Date.now() };
    requests.push(request);
    const body = await handler(request);
    if (body === FAIL) {
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (root) act(() => root!.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await act(() => sleep(10));
  }
}

function wireEvent(
  spanId: string,
  parentSpanId: string,
  insertedAtMs: number,
  overrides: Partial<{ kind: string; message: string; status: string }> = {}
) {
  return {
    spanId,
    parentSpanId,
    runId: "run_1",
    startTime: new Date(T0).toISOString(),
    startTimeNano: String(BigInt(T0) * 1_000_000n),
    insertedAt: String(insertedAtMs),
    duration: 0,
    status: "PARTIAL",
    kind: "SPAN",
    message: spanId,
    metadata: "{}",
    ...overrides,
  };
}

function payload(
  rootSpanId: string,
  firstEvents: ReturnType<typeof wireEvent>[],
  overrides: Partial<NonNullable<ProgressiveTraceInput["progressive"]>> = {}
): ProgressiveTraceInput {
  return {
    events: [],
    duration: 0,
    rootStartedAt: undefined,
    rootSpanStatus: "executing",
    progressive: {
      firstEvents,
      nextCursor: null,
      hasMore: false,
      buildOptions: { rootSpanId, runFriendlyId: "run_1", isAgentRun: false, isAdmin: false },
      showDebug: false,
      liveTailEnabled: true,
      firstChunkReadAt: T0,
      ...overrides,
    },
  };
}

type HookResult = ReturnType<typeof useProgressiveTrace>;

function render(trace: ProgressiveTraceInput, chunkPath: string, errorsOnly = false) {
  let latest!: HookResult;
  function Harness(props: { trace: ProgressiveTraceInput; chunkPath: string }) {
    // oxlint-disable-next-line react/globals -- test harness capturing the hook's return value.
    latest = useProgressiveTrace(props.trace, props.chunkPath, errorsOnly);
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness, { trace, chunkPath })));
  return {
    result: () => latest,
    ids: () => latest.events.map((event) => event.id),
    rerender: (next: ProgressiveTraceInput, nextPath = chunkPath) =>
      act(() => root!.render(createElement(Harness, { trace: next, chunkPath: nextPath }))),
  };
}

const isTail = (request: Request) => request.params.has("insertedAtSince");
const backgroundRequests = () => requests.filter((request) => !isTail(request));

describe("useProgressiveTrace live tail", () => {
  it("keeps the loaded tree when the same run revalidates", async () => {
    handler = () => ({
      events: [wireEvent("child", "root", T0 + 1_000)],
      nextCursor: null,
      hasMore: false,
    });
    const view = render(
      payload("root", [wireEvent("root", "", T0)], {
        hasMore: true,
        nextCursor: { startTime: "1", spanId: "root" },
      }),
      `${baseUrl}/a/chunk`
    );
    await waitFor(() => view.result().isComplete && view.ids().includes("child"));
    expect(backgroundRequests()).toHaveLength(1);

    view.rerender(
      payload("root", [wireEvent("root", "", T0), wireEvent("other", "root", T0)], {
        hasMore: true,
        nextCursor: { startTime: "1", spanId: "other" },
      })
    );
    await act(() => sleep(150));

    expect(backgroundRequests()).toHaveLength(1);
    expect(view.ids()).toContain("child");
  });

  it("lands the root's final row from a revalidate after stopping at the ceiling", async () => {
    handler = () => ({
      events: [wireEvent("child", "root", T0 + 1_000)],
      nextCursor: null,
      hasMore: false,
    });
    const options = {
      hasMore: true,
      nextCursor: { startTime: "1", spanId: "root" },
      maxSpans: 1,
    };
    const view = render(
      payload("root", [wireEvent("root", "", T0)], options),
      `${baseUrl}/a/chunk`
    );
    await waitFor(() => view.result().isTruncated && view.ids().includes("child"));
    expect(view.result().rootSpanStatus).toBe("executing");

    view.rerender(
      payload(
        "root",
        [wireEvent("root", "", T0), wireEvent("root", "", T0 + 5_000, { status: "OK" })],
        options
      )
    );
    await waitFor(() => view.result().rootSpanStatus === "completed");
    expect(view.ids()).toContain("child");
    expect(backgroundRequests()).toHaveLength(1);
  });

  it("reads back to the first-chunk read time on the first tail after the load", async () => {
    handler = (request) =>
      isTail(request)
        ? { events: [], nextCursor: null, hasMore: false }
        : { events: [wireEvent("late", "root", T0 + 60_000)], nextCursor: null, hasMore: false };
    const view = render(
      payload("root", [wireEvent("root", "", T0)], {
        hasMore: true,
        nextCursor: { startTime: "1", spanId: "root" },
      }),
      `${baseUrl}/a/chunk`
    );
    await waitFor(() => view.result().isComplete && view.ids().includes("late"));

    act(() => view.result().tailLive());
    await waitFor(() => requests.some(isTail));

    expect(Number(requests.find(isTail)!.params.get("insertedAtSince"))).toBe(T0 - 30_000);
  });

  it("ignores a tail that resolves after moving to another run", async () => {
    let releaseA!: () => void;
    const aReleased = new Promise<void>((resolve) => (releaseA = resolve));
    handler = async (request) => {
      if (request.path === "/a/chunk" && isTail(request)) {
        await aReleased;
        return {
          events: [wireEvent("a-late", "root-a", T0 + 5_000)],
          nextCursor: null,
          hasMore: false,
        };
      }
      if (request.path === "/b/chunk" && isTail(request)) {
        return {
          events: [wireEvent("b-new", "root-b", T0 + 5_000)],
          nextCursor: null,
          hasMore: false,
        };
      }
      return { events: [], nextCursor: null, hasMore: false };
    };
    const view = render(payload("root-a", [wireEvent("root-a", "", T0)]), `${baseUrl}/a/chunk`);
    act(() => view.result().tailLive());
    await waitFor(() => requests.some((r) => r.path === "/a/chunk" && isTail(r)));

    view.rerender(payload("root-b", [wireEvent("root-b", "", T0)]), `${baseUrl}/b/chunk`);
    act(() => view.result().tailLive());
    await waitFor(() => view.ids().includes("b-new"));

    releaseA();
    await act(() => sleep(100));

    expect(view.ids()).toContain("root-b");
    expect(view.ids()).not.toContain("a-late");
  });

  it("defers a throttled tail to the end of the interval instead of dropping it", async () => {
    const children = Array.from({ length: 5_000 }, (_, i) => wireEvent(`s${i}`, "root", T0));
    const view = render(
      payload("root", [wireEvent("root", "", T0), ...children]),
      `${baseUrl}/a/chunk`
    );

    act(() => view.result().tailLive());
    await waitFor(() => requests.filter(isTail).length === 1);
    await act(() => sleep(50));
    act(() => view.result().tailLive());
    await act(() => sleep(200));
    expect(requests.filter(isTail)).toHaveLength(1);

    await waitFor(() => requests.filter(isTail).length === 2, 4_000);
    const [first, second] = requests.filter(isTail);
    expect(second.at - first.at).toBeGreaterThanOrEqual(1_500);
  });

  it("does not duplicate deep-link events when a revalidate re-sends the payload", async () => {
    const deepLinked = () => [
      wireEvent("root", "", T0),
      wireEvent("root", "", T0 + 10, { kind: "SPAN_EVENT", message: "trigger.dev/start" }),
    ];
    const buildOptions = {
      rootSpanId: "root",
      runFriendlyId: "run_1",
      isAgentRun: false,
      isAdmin: true,
    };
    const view = render(
      payload("root", [wireEvent("root", "", T0)], {
        supplementaryFirstEvents: deepLinked(),
        buildOptions,
      }),
      `${baseUrl}/a/chunk`
    );
    view.rerender(
      payload("root", [wireEvent("root", "", T0)], {
        supplementaryFirstEvents: deepLinked(),
        buildOptions,
      })
    );
    await waitFor(() => view.ids().includes("root"));
    const root = view.result().events.find((event) => event.id === "root");
    expect(root?.data.timelineEvents).toHaveLength(1);
  });

  it("reloads the tree when showDebug changes", async () => {
    const options = { hasMore: true, nextCursor: { startTime: "1", spanId: "root" } };
    const view = render(
      payload("root", [wireEvent("root", "", T0)], options),
      `${baseUrl}/a/chunk`
    );
    await waitFor(() => view.result().isComplete);

    view.rerender(payload("root", [wireEvent("root", "", T0)], { ...options, showDebug: true }));
    await waitFor(() => backgroundRequests().length === 2);
    expect(backgroundRequests()[1].params.get("debug")).toBe("1");
  });

  it("skips the errors-only fetch once every chunk is loaded", async () => {
    const view = render(payload("root", [wireEvent("root", "", T0)]), `${baseUrl}/a/chunk`, true);
    expect(view.result().isComplete).toBe(true);
    await act(() => sleep(100));
    expect(requests.filter((r) => r.params.get("filter") === "errors")).toHaveLength(0);
  });

  it("stops loading and marks the trace truncated when a page was capped", async () => {
    handler = () => ({
      events: [wireEvent("child", "root", T0 + 1_000)],
      nextCursor: null,
      hasMore: false,
      isTruncated: true,
    });
    const view = render(
      payload("root", [wireEvent("root", "", T0)], {
        hasMore: true,
        nextCursor: { startTime: "1", spanId: "root" },
      }),
      `${baseUrl}/a/chunk`
    );
    await waitFor(() => view.result().isComplete);
    expect(view.result().isTruncated).toBe(true);
    expect(backgroundRequests()).toHaveLength(1);
  });

  it("doesn't mark the trace truncated when errors-only results are capped", async () => {
    handler = (request) =>
      request.params.get("filter") === "errors"
        ? {
            events: [wireEvent("err", "root", T0 + 1_000)],
            nextCursor: null,
            hasMore: false,
            isTruncated: true,
          }
        : new Promise(() => {});
    const view = render(
      payload("root", [wireEvent("root", "", T0)], {
        hasMore: true,
        nextCursor: { startTime: "1", spanId: "root" },
      }),
      `${baseUrl}/a/chunk`,
      true
    );
    await waitFor(() => view.result().events.some((event) => event.id === "err"));
    expect(view.result().isTruncated).toBe(false);
    expect(view.result().isComplete).toBe(false);
  });

  it("re-fetches errors-only spans after a retry", async () => {
    handler = (request) =>
      request.params.get("filter") === "errors"
        ? { events: [], nextCursor: null, hasMore: false }
        : FAIL;
    const view = render(
      payload("root", [wireEvent("root", "", T0)], {
        hasMore: true,
        nextCursor: { startTime: "1", spanId: "root" },
      }),
      `${baseUrl}/a/chunk`,
      true
    );
    const errorRequests = () => requests.filter((r) => r.params.get("filter") === "errors");
    await waitFor(() => view.result().loadFailed && errorRequests().length === 1, 4_000);

    act(() => view.result().retryLoad());
    await waitFor(() => errorRequests().length === 2, 4_000);
  });

  it("waits for the tab to be visible before tailing", async () => {
    const setVisibility = (state: "hidden" | "visible") => {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const view = render(payload("root", [wireEvent("root", "", T0)]), `${baseUrl}/a/chunk`);
    try {
      setVisibility("hidden");
      act(() => view.result().tailLive());
      await act(() => sleep(100));
      expect(requests.filter(isTail)).toHaveLength(0);

      act(() => setVisibility("visible"));
      await waitFor(() => requests.filter(isTail).length === 1);
    } finally {
      setVisibility("visible");
    }
  });

  it("does not rebuild when a re-sent deep-link payload changes nothing", async () => {
    const deepLinked = () => [wireEvent("root", "", T0), wireEvent("child", "root", T0)];
    const view = render(
      payload("root", [wireEvent("root", "", T0)], { supplementaryFirstEvents: deepLinked() }),
      `${baseUrl}/a/chunk`
    );
    view.rerender(
      payload("root", [wireEvent("root", "", T0)], { supplementaryFirstEvents: deepLinked() })
    );
    await waitFor(() => view.ids().includes("child"));
    const eventsAfterFirstMerge = view.result().events;

    view.rerender(
      payload("root", [wireEvent("root", "", T0)], { supplementaryFirstEvents: deepLinked() })
    );
    await act(() => sleep(50));
    expect(view.result().events).toBe(eventsAfterFirstMerge);
  });
});
