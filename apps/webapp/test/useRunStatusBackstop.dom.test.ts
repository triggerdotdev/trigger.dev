// @vitest-environment jsdom
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useRunStatusBackstop } from "~/hooks/useRunStatusBackstop";

type Reply = { status: number; body?: unknown };

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
  container?.remove();
  container = undefined;
  root = undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function render(props: { enabled?: boolean; skip?: () => boolean }) {
  let finished = 0;
  function Harness({ enabled }: { enabled: boolean }) {
    useRunStatusBackstop({
      enabled,
      statusPath: `${baseUrl}/status`,
      shouldSkip: props.skip ?? (() => false),
      onFinished: () => finished++,
      pollMs: 20,
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
    replies = [
      { status: 200, body: { isFinished: false, completedAt: null } },
      { status: 200, body: { isFinished: true, completedAt: null } },
    ];
    const harness = render({});
    await act(() => sleep(200));
    expect(harness.finished()).toBeGreaterThan(1);

    harness.disable();
    const finishedAtDisable = harness.finished();
    const requestsAtDisable = requests;
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
    await act(() => sleep(250));
    expect(harness.finished()).toBeGreaterThanOrEqual(1);
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
