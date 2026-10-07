// @vitest-environment jsdom
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRunStatusBackstop } from "~/hooks/useRunStatusBackstop";

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
  let finished = 0;
  function Harness({ enabled }: { enabled: boolean }) {
    useRunStatusBackstop({
      enabled,
      statusPath: `${baseUrl}/status`,
      shouldSkip: props.skip ?? (() => false),
      onFinished: () => finished++,
      pollMs: POLL_MS,
    });
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(createElement(Harness, { enabled: props.enabled ?? true })));
  return {
    finished: () => finished,
    disable: () => act(() => root!.render(createElement(Harness, { enabled: false }))),
  };
}

describe("useRunStatusBackstop", () => {
  it("calls onFinished on each poll that sees the run finished until disabled", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    replies = [
      { status: 200, body: { isFinished: false, completedAt: null } },
      { status: 200, body: { isFinished: true, completedAt: null } },
    ];
    const harness = render({});
    poll();
    await expect.poll(() => requests, ASSERTION_POLL_OPTIONS).toBe(1);
    expect(harness.finished()).toBe(0);
    poll();
    await expect.poll(harness.finished, ASSERTION_POLL_OPTIONS).toBe(1);
    poll();
    await expect.poll(harness.finished, ASSERTION_POLL_OPTIONS).toBe(2);

    harness.disable();
    const finishedAtDisable = harness.finished();
    const requestsAtDisable = requests;
    act(() => vi.advanceTimersByTime(POLL_MS * 5));
    await act(() => sleep(100));
    expect(harness.finished()).toBe(finishedAtDisable);
    expect(requests).toBe(requestsAtDisable);
  });

  it("ignores failed polls and keeps polling", async () => {
    replies = [
      { status: 404 },
      { status: 500 },
      { status: 200, body: { isFinished: false, completedAt: "2026-10-06T10:00:00.000Z" } },
    ];
    const harness = render({});
    await expect.poll(harness.finished).toBeGreaterThanOrEqual(1);
  });

  it("does not poll while shouldSkip is true", async () => {
    replies = [{ status: 200, body: { isFinished: true, completedAt: null } }];
    const harness = render({ skip: () => true });
    await act(() => sleep(150));
    expect(requests).toBe(0);
    expect(harness.finished()).toBe(0);
  });

  it("does not poll when disabled", async () => {
    replies = [{ status: 200, body: { isFinished: true, completedAt: null } }];
    render({ enabled: false });
    await act(() => sleep(100));
    expect(requests).toBe(0);
  });
});
