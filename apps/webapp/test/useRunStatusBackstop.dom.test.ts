// @vitest-environment jsdom
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRunStatusBackstop } from "~/hooks/useRunStatusBackstop";
import type { RunStatusData } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.status";

type Reply = { status: number; body?: unknown };

const POLL_MS = 20;
// expect.poll otherwise advances fake timers on every retry.
const ASSERTION_POLL_OPTIONS = { interval: 0 };

let server: Server;
let baseUrl: string;
let replies: Reply[];
let requests: number;
let container: HTMLDivElement | undefined;
let root: Root | undefined;

beforeEach(async () => {
  replies = [];
  requests = 0;
  server = createServer((_req, res) => {
    requests++;
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    res.writeHead(reply?.status ?? 500, { "content-type": "application/json" });
    res.end(reply?.body === undefined ? "" : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (root) act(() => root!.unmount());
  vi.useRealTimers();
  container?.remove();
  container = undefined;
  root = undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function poll() {
  act(() => vi.advanceTimersByTime(POLL_MS));
}

function render(props: { enabled?: boolean; skip?: () => boolean }) {
  const seen: RunStatusData[] = [];
  function Harness({ enabled }: { enabled: boolean }) {
    useRunStatusBackstop({
      enabled,
      statusPath: `${baseUrl}/status`,
      shouldSkip: props.skip ?? (() => false),
      onStatus: (data) => seen.push(data),
      pollMs: POLL_MS,
    });
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness, { enabled: props.enabled ?? true })));
  return {
    seen: () => seen,
    count: () => seen.length,
    disable: () => act(() => root!.render(createElement(Harness, { enabled: false }))),
  };
}

describe("useRunStatusBackstop", () => {
  it("passes each poll's data to onStatus until disabled", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const queued = { isFinished: false, startedAt: null, completedAt: null };
    const started = { isFinished: false, startedAt: "2026-10-06T10:00:00.000Z", completedAt: null };
    replies = [
      { status: 200, body: queued },
      { status: 200, body: started },
    ];
    const harness = render({});
    poll();
    await expect.poll(harness.count, ASSERTION_POLL_OPTIONS).toBe(1);
    expect(harness.seen()[0]).toEqual(queued);
    poll();
    await expect.poll(harness.count, ASSERTION_POLL_OPTIONS).toBe(2);
    expect(harness.seen()[1]).toEqual(started);

    harness.disable();
    const seenAtDisable = harness.count();
    const requestsAtDisable = requests;
    act(() => vi.advanceTimersByTime(POLL_MS * 5));
    await act(() => sleep(100));
    expect(harness.count()).toBe(seenAtDisable);
    expect(requests).toBe(requestsAtDisable);
  });

  it("ignores failed and unparseable polls and keeps polling", async () => {
    const finished = {
      isFinished: true,
      startedAt: "2026-10-06T10:00:00.000Z",
      completedAt: "2026-10-06T10:01:00.000Z",
    };
    replies = [{ status: 404 }, { status: 500 }, { status: 200 }, { status: 200, body: finished }];
    const harness = render({});
    await expect.poll(harness.count).toBeGreaterThanOrEqual(1);
    expect(harness.seen().every((data) => data.isFinished)).toBe(true);
  });

  it("does not poll while shouldSkip is true", async () => {
    replies = [{ status: 200, body: { isFinished: true, startedAt: null, completedAt: null } }];
    const harness = render({ skip: () => true });
    await act(() => sleep(150));
    expect(requests).toBe(0);
    expect(harness.count()).toBe(0);
  });

  it("does not poll when disabled", async () => {
    replies = [{ status: 200, body: { isFinished: true, startedAt: null, completedAt: null } }];
    render({ enabled: false });
    await act(() => sleep(100));
    expect(requests).toBe(0);
  });
});
