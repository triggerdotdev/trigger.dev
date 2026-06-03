import { describe, expect, it, vi } from "vitest";

// Per-test override for the stubbed SessionStreamInstance's wait() so a
// test can simulate downstream writer failures (e.g. S2 auth error after
// initializeSessionStream returned a stale token). Reset at the top of
// each test that touches it.
let stubWaitImpl: (() => Promise<{ lastEventId?: string }>) | undefined;

// Stub `SessionStreamInstance` so constructing a channel writer doesn't try
// to reach S2. The stub still invokes the `initializeSession` callback the
// channel passes in, which is the whole point: that's how the cache gets
// exercised. wait() resolves immediately by default; tests can override it
// via `stubWaitImpl` to verify reactive invalidation on writer failure.
vi.mock("@trigger.dev/core/v3", async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  class StubSessionStreamInstance<T> {
    private waitPromise: Promise<{ lastEventId?: string }>;
    constructor(opts: {
      source: ReadableStream<T>;
      initializeSession?: () => Promise<{ headers?: Record<string, string> }>;
    }) {
      // Drain the source so the upstream tee doesn't backpressure-stall.
      void (async () => {
        const reader = opts.source.getReader();
        try {
          while (true) {
            const { done } = await reader.read();
            if (done) break;
          }
        } finally {
          reader.releaseLock();
        }
      })();
      // Trigger the initializeSession callback so the cache path runs.
      opts.initializeSession?.().catch(() => {
        // Failures are observed via the spy; swallow here so unhandled
        // rejection warnings don't leak through the stub.
      });
      // Capture the wait outcome once at construction (mirrors real
      // SessionStreamInstance which kicks off initializeWriter from the
      // ctor). All subsequent wait() calls return the same promise so
      // a single failure is observable by every consumer in the channel
      // (`.finally`, reactive `.catch`, and customer `waitUntilComplete`).
      this.waitPromise = stubWaitImpl
        ? stubWaitImpl()
        : Promise.resolve({ lastEventId: undefined });
      // Claim any rejection so test runs don't surface as unhandled.
      // Real awaiters still observe the rejection when they `await` it.
      this.waitPromise.catch(() => {});
    }
    async wait() {
      return this.waitPromise;
    }
    get stream() {
      return new ReadableStream<T>({ start: (c) => c.close() });
    }
  }
  return { ...actual, SessionStreamInstance: StubSessionStreamInstance };
});

import { SessionOutputChannel } from "./sessions.js";
import { apiClientManager } from "@trigger.dev/core/v3";

type ApiClientStub = {
  initializeSessionStream: ReturnType<typeof vi.fn>;
};

function installStubApiClient(impl: ApiClientStub["initializeSessionStream"]): ApiClientStub {
  const stub: ApiClientStub = { initializeSessionStream: impl };
  // `apiClientManager.clientOrThrow()` is what `#pipeInternal` reaches for.
  vi.spyOn(apiClientManager, "clientOrThrow").mockReturnValue(
    stub as unknown as ReturnType<typeof apiClientManager.clientOrThrow>
  );
  return stub;
}

function emptyStream(): ReadableStream<unknown> {
  return new ReadableStream({ start: (c) => c.close() });
}

describe("SessionOutputChannel initializeSessionStream cache", () => {
  it("dedupes repeated pipe()/writer() calls for the same channel", async () => {
    stubWaitImpl = undefined;
    const spy = vi.fn(async () => ({ version: "v2", headers: {} }));
    installStubApiClient(spy);

    const channel = new SessionOutputChannel("session-1");
    const p1 = channel.pipe(emptyStream());
    const p2 = channel.pipe(emptyStream());
    const p3 = channel.writer({
      execute: ({ write }) => {
        write({ chunk: 1 });
      },
    });

    await Promise.all([p1.waitUntilComplete(), p2.waitUntilComplete(), p3.waitUntilComplete()]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("session-1", "out", undefined);
  });

  it("evicts on initialize failure so the next call retries instead of returning a poisoned entry", async () => {
    stubWaitImpl = undefined;
    const spy = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ version: "v2", headers: {} });
    installStubApiClient(spy);

    const channel = new SessionOutputChannel("session-1");
    const firstAttempt = channel.pipe(emptyStream());
    // First call fails — the stub swallows the rejection on the
    // initializeSession callback, but the cache eviction handler still runs.
    await firstAttempt.waitUntilComplete();
    // Settle pending microtasks so the .catch() eviction fires.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const retried = channel.pipe(emptyStream());
    await retried.waitUntilComplete();

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("reset() clears cached entries so the next call re-PUTs", async () => {
    stubWaitImpl = undefined;
    const spy = vi.fn(async () => ({ version: "v2", headers: {} }));
    installStubApiClient(spy);

    const channel = new SessionOutputChannel("session-1");
    await channel.pipe(emptyStream()).waitUntilComplete();
    expect(spy).toHaveBeenCalledTimes(1);

    channel.reset();

    await channel.pipe(emptyStream()).waitUntilComplete();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("scopes the cache per channel instance", async () => {
    stubWaitImpl = undefined;
    const spy = vi.fn(async () => ({ version: "v2", headers: {} }));
    installStubApiClient(spy);

    const channelA = new SessionOutputChannel("session-a");
    const channelB = new SessionOutputChannel("session-b");

    await Promise.all([
      channelA.pipe(emptyStream()).waitUntilComplete(),
      channelB.pipe(emptyStream()).waitUntilComplete(),
    ]);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenCalledWith("session-a", "out", undefined);
    expect(spy).toHaveBeenCalledWith("session-b", "out", undefined);
  });

  it("evicts the cache when a writer's wait() rejects (simulated stale-token failure)", async () => {
    const spy = vi.fn(async () => ({ version: "v2", headers: {} }));
    installStubApiClient(spy);

    // First writer's wait() rejects (e.g. S2 returned 401 after the cached
    // token expired mid-process); subsequent writers' wait() resolve cleanly.
    let waitCallCount = 0;
    stubWaitImpl = async () => {
      waitCallCount++;
      if (waitCallCount === 1) throw new Error("S2 auth failed: token expired");
      return { lastEventId: undefined };
    };

    const channel = new SessionOutputChannel("session-1");

    const failed = channel.pipe(emptyStream());
    await expect(failed.waitUntilComplete()).rejects.toThrow(/token expired/);

    // Settle microtasks so the reactive .catch eviction handler fires.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const recovered = channel.pipe(emptyStream());
    await recovered.waitUntilComplete();

    // Cache evicted ⇒ second pipe() re-PUT ⇒ two distinct initialize calls.
    expect(spy).toHaveBeenCalledTimes(2);

    stubWaitImpl = undefined;
  });
});
