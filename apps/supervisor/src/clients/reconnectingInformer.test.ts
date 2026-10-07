import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type KubeConfig, type KubernetesObject, ListWatch, Watch } from "@kubernetes/client-node";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { ReconnectingInformer } from "./reconnectingInformer.js";

describe("ReconnectingInformer watch stalls", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  type WatchCall = { path: string; done: (err: unknown) => void; aborted: boolean };

  function makeInformer(
    watch: Pick<Watch, "watch">,
    opts: { watchTimeoutSeconds?: number; onStall?: (quietMs: number) => void } = {}
  ) {
    return new ReconnectingInformer<KubernetesObject>({
      name: "test-informer",
      logger: new SimpleStructuredLogger("test-informer"),
      reconnectIntervalMs: 1,
      path: "/api/v1/namespaces/v4-runs/pods",
      list: async () => ({ items: [], metadata: { resourceVersion: "1" } }),
      makeInformer: (path, list) => new ListWatch(path, watch as Watch, list, false),
      ...opts,
    });
  }

  /** A fake Watch that stays silent until told otherwise. */
  function setup(opts: Parameters<typeof makeInformer>[1] = { watchTimeoutSeconds: 300 }) {
    const calls: WatchCall[] = [];
    const watch = {
      watch: vi.fn(
        async (path: string, _query: unknown, _callback: unknown, done: WatchCall["done"]) => {
          const call: WatchCall = { path, done, aborted: false };
          calls.push(call);
          return { abort: () => (call.aborted = true) } as unknown as AbortController;
        }
      ),
    };
    return { calls, informer: makeInformer(watch, opts) };
  }

  it("asks the server to close each watch at the timeout", async () => {
    const { calls, informer } = setup();
    await informer.start();

    expect(calls[0]!.path).toBe("/api/v1/namespaces/v4-runs/pods?timeoutSeconds=300");
    await informer.stop();
  });

  // A connection that died without closing raises nothing on its own.
  it("reconnects a watch that neither delivers nor closes past the timeout", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const onStall = vi.fn();
    const { calls, informer } = setup({ watchTimeoutSeconds: 300, onStall });
    await informer.start();

    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls).toHaveLength(1);

    // The check runs every 30 s, so the first past 330 s quiet is at 360 s.
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]!.aborted).toBe(true);
    expect(onStall).toHaveBeenCalledOnce();
    await informer.stop();
  });

  it("leaves alone a watch the server closes and the client renews", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const onStall = vi.fn();
    const { calls, informer } = setup({ watchTimeoutSeconds: 300, onStall });
    await informer.start();

    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(300_000);
      calls.at(-1)!.done(null);
      await vi.waitFor(() => expect(calls).toHaveLength(i + 1));
    }
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toHaveLength(4);
    expect(onStall).not.toHaveBeenCalled();
    await informer.stop();
  });

  it("sets no timeout and checks nothing without a watch timeout", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const { calls, informer } = setup({});
    await informer.start();

    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe("/api/v1/namespaces/v4-runs/pods");
    await informer.stop();
  });

  /** Polls on real timers, which the fake ones in these tests leave alone. */
  async function realTimeUntil(condition: () => boolean) {
    for (let i = 0; i < 400 && !condition(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(condition()).toBe(true);
  }

  /** A real client Watch against a local API server that answers each watch as told. */
  async function realWatch(answer: (n: number, res: ServerResponse) => void) {
    const watches: IncomingMessage[] = [];
    const server = createServer((req, res) => {
      watches.push(req);
      answer(watches.length, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // A KubeConfig always fetches through an https agent; this is plain http.
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const kc = {
      getCurrentCluster: () => ({ server: url }),
      applyToFetchOptions: async () => ({}),
    } as unknown as KubeConfig;
    const close = () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    return { watch: new Watch(kc), watches, close };
  }

  // The client only returns the request's controller once the headers arrive.
  it("aborts a watch whose headers never arrive", async () => {
    const before = Watch.HEADERS_TIMEOUT_MS;
    Watch.HEADERS_TIMEOUT_MS = 50;
    const { watch, close } = await realWatch(() => {});
    try {
      const done = vi.fn();
      await watch.watch("/api/v1/pods", {}, () => {}, done);
      expect(done).toHaveBeenCalledWith(expect.objectContaining({ name: "AbortError" }));
    } finally {
      Watch.HEADERS_TIMEOUT_MS = before;
      await close();
    }
  });

  // The stall's reconnect meets a blackholed connection too: it must give up on
  // it rather than hold the reconnect guard, and watch again.
  it("recovers when the reconnect after a stall never gets its headers", async () => {
    const before = Watch.HEADERS_TIMEOUT_MS;
    Watch.HEADERS_TIMEOUT_MS = 50;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    // The first watch connects and goes silent, the second never answers, the third connects.
    const { watch, watches, close } = await realWatch((n, res) => {
      if (n !== 2) {
        res.writeHead(200, { "content-type": "application/json" });
        res.flushHeaders();
      }
    });
    const informer = makeInformer(watch, { watchTimeoutSeconds: 300 });
    const reconnecting = () => (informer as unknown as { reconnecting: boolean }).reconnecting;
    try {
      await informer.start();
      await vi.waitFor(() => expect(watches).toHaveLength(1));

      await vi.advanceTimersByTimeAsync(360_000);
      // The second watch's header timeout runs on real time; only once it fires
      // does the reconnect watch a third time and settle.
      await realTimeUntil(() => watches.length === 3 && !reconnecting());
    } finally {
      await informer.stop();
      Watch.HEADERS_TIMEOUT_MS = before;
      await close();
    }
  });
});
