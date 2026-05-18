import { afterEach, describe, expect, it, vi } from "vitest";
import { SSEStreamSubscription } from "./runStream.js";

vi.setConfig({ testTimeout: 10_000 });

describe("SSEStreamSubscription retry behavior", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // A response.body that emits one SSE event then closes, so each
  // successful subscribe() exits cleanly via reader.read() done=true
  // and the test doesn't hang reading from a long-lived stream.
  function makeSSEResponse() {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`id: 1\ndata: {"hello":1}\n\n`));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "X-Stream-Version": "v1" },
    });
  }

  // Drain a ReadableStream<SSEStreamPart> until it closes or errors.
  // Returns received chunks plus terminal state.
  async function drain(stream: ReadableStream<{ id: string; chunk: unknown }>) {
    const reader = stream.getReader();
    const chunks: Array<{ id: string; chunk: unknown }> = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return { chunks, error: undefined as Error | undefined };
        chunks.push(value);
      }
    } catch (e) {
      return { chunks, error: e as Error };
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
  }

  it("retries past the legacy 5-attempt cap", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 8) {
        throw new TypeError("fetch failed (simulated network drop)");
      }
      return makeSSEResponse();
    });

    const sub = new SSEStreamSubscription("http://example.test/sse", {
      // Compress the timing for the test — defaults are 100ms initial,
      // 5s cap, retry forever; here we want fast iteration.
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
    });

    const stream = await sub.subscribe();
    const result = await drain(stream);

    expect(attempts).toBe(8);
    expect(result.error).toBeUndefined();
    expect(result.chunks).toHaveLength(1);
  });

  it("caps the exponential backoff at maxRetryDelayMs", async () => {
    let attempts = 0;
    const callTimes: number[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callTimes.push(Date.now());
      attempts++;
      if (attempts < 6) {
        throw new TypeError("fetch failed");
      }
      return makeSSEResponse();
    });

    const sub = new SSEStreamSubscription("http://example.test/sse", {
      retryDelayMs: 10,
      maxRetryDelayMs: 30,
    });

    const stream = await sub.subscribe();
    await drain(stream);

    expect(attempts).toBe(6);

    // Without the cap, backoff would be 10, 20, 40, 80, 160 (= 310ms total).
    // With cap=30, it's 10, 20, 30, 30, 30 (= 120ms total). Allow generous
    // slack for setTimeout jitter; the assertion is "well under uncapped".
    const totalElapsed = callTimes.at(-1)! - callTimes[0]!;
    expect(totalElapsed).toBeLessThan(250);
  });

  it("retryNow() wakes an in-flight backoff and reconnects immediately", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        throw new TypeError("fetch failed");
      }
      return makeSSEResponse();
    });

    const sub = new SSEStreamSubscription("http://example.test/sse", {
      // Backoff is intentionally long. retryNow() should short-circuit it.
      retryDelayMs: 5_000,
      maxRetryDelayMs: 5_000,
    });

    const subscribePromise = sub.subscribe().then(drain);

    // Wait for the first attempt to fail and the backoff to start.
    await new Promise((r) => setTimeout(r, 50));
    sub.retryNow();

    const start = Date.now();
    const result = await subscribePromise;
    const elapsed = Date.now() - start;

    expect(attempts).toBe(2);
    expect(result.error).toBeUndefined();
    // Without retryNow this would have waited ~5000ms; with it, the
    // second attempt fires nearly immediately after the first failure.
    expect(elapsed).toBeLessThan(500);
  });

  it("respects abort signal during retry backoff", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      attempts++;
      throw new TypeError("fetch failed");
    });

    const ac = new AbortController();
    const sub = new SSEStreamSubscription("http://example.test/sse", {
      signal: ac.signal,
      retryDelayMs: 1_000,
      maxRetryDelayMs: 1_000,
    });

    const subscribePromise = sub.subscribe().then(drain);

    // Let the first attempt fail and enter backoff, then abort.
    await new Promise((r) => setTimeout(r, 50));
    ac.abort();

    const result = await subscribePromise;
    expect(result.error).toBeUndefined();
    // Abort should stop retries; we should have made at most a couple
    // of attempts before the abort took effect.
    expect(attempts).toBeLessThanOrEqual(2);
  });

  it("forceReconnect mid-read drops the stream and resumes with Last-Event-ID", async () => {
    let attempts = 0;
    const seenLastEventIds: Array<string | null> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      attempts++;
      const lastEventIdHeader = (init?.headers as Record<string, string> | undefined)?.[
        "Last-Event-ID"
      ];
      seenLastEventIds.push(lastEventIdHeader ?? null);

      if (attempts === 1) {
        // Headers arrive immediately, body emits one chunk then hangs
        // until aborted. The test calls forceReconnect after seeing
        // the chunk, which should drop this stream and trigger a
        // resume request with Last-Event-ID set.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`id: 7\ndata: {"first":true}\n\n`));
            init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "X-Stream-Version": "v1" },
        });
      }
      // Second attempt: emit a second chunk and close cleanly.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`id: 8\ndata: {"second":true}\n\n`));
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/event-stream", "X-Stream-Version": "v1" },
      });
    });

    const sub = new SSEStreamSubscription("http://example.test/sse", {
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
      fetchTimeoutMs: 60_000,
    });

    const stream = await sub.subscribe();
    const reader = stream.getReader();

    // Read the first chunk, then force-reconnect mid-stream.
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect((first.value!.chunk as { first?: boolean }).first).toBe(true);

    sub.forceReconnect();

    // Second chunk arrives from the resumed connection.
    const second = await reader.read();
    expect(second.done).toBe(false);
    expect((second.value!.chunk as { second?: boolean }).second).toBe(true);

    const tail = await reader.read();
    expect(tail.done).toBe(true);

    expect(attempts).toBe(2);
    expect(seenLastEventIds[0]).toBeNull();
    // Resumed request includes the Last-Event-ID from the first chunk.
    expect(seenLastEventIds[1]).toBe("7");
  });

  it("forceReconnect aborts the in-flight fetch and retries", async () => {
    let attempts = 0;
    let firstResolve: (() => void) | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      attempts++;
      if (attempts === 1) {
        // Hang the first attempt forever (or until signal aborts).
        // forceReconnect should make this attempt's signal abort and
        // throw, taking us into the retry path.
        return new Promise((resolve, reject) => {
          firstResolve = () => resolve(makeSSEResponse());
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return makeSSEResponse();
    });

    const sub = new SSEStreamSubscription("http://example.test/sse", {
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
      // Long fetch timeout so it doesn't fire instead of forceReconnect.
      fetchTimeoutMs: 60_000,
    });

    const subscribePromise = sub.subscribe().then(drain);

    // Let the first fetch hang, then force reconnect.
    await new Promise((r) => setTimeout(r, 50));
    sub.forceReconnect();

    const result = await subscribePromise;
    expect(attempts).toBe(2);
    expect(result.error).toBeUndefined();
    expect(result.chunks).toHaveLength(1);
    // Sanity: the hung first fetch was abandoned, never resolved.
    expect(firstResolve).toBeDefined();
  });

  it("aborts a slow fetch via fetchTimeoutMs and retries", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      attempts++;
      if (attempts === 1) {
        // Hang until aborted.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return makeSSEResponse();
    });

    const sub = new SSEStreamSubscription("http://example.test/sse", {
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
      fetchTimeoutMs: 100,
    });

    const result = await sub.subscribe().then(drain);
    expect(attempts).toBe(2);
    expect(result.error).toBeUndefined();
    expect(result.chunks).toHaveLength(1);
  });

  it("aborts a silent reader via stallTimeoutMs and retries", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      attempts++;
      if (attempts === 1) {
        // Headers arrive immediately, but the body stream emits no
        // chunks until aborted. The stall timer should fire and
        // force a reconnect.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream", "X-Stream-Version": "v1" },
        });
      }
      return makeSSEResponse();
    });

    const sub = new SSEStreamSubscription("http://example.test/sse", {
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
      stallTimeoutMs: 100,
    });

    const result = await sub.subscribe().then(drain);
    expect(attempts).toBe(2);
    expect(result.error).toBeUndefined();
    expect(result.chunks).toHaveLength(1);
  });

  it("does not retry on 404 (stream gone)", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      attempts++;
      return new Response("not found", { status: 404 });
    });

    const errors: Error[] = [];
    const sub = new SSEStreamSubscription("http://example.test/sse", {
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
      onError: (e) => errors.push(e),
    });

    const result = await sub.subscribe().then(drain);
    expect(attempts).toBe(1);
    expect(result.error).toBeDefined();
    expect(errors).toHaveLength(1);
  });

  it("does not retry on 410 (session closed)", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      attempts++;
      return new Response("gone", { status: 410 });
    });

    const sub = new SSEStreamSubscription("http://example.test/sse", {
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
    });

    const result = await sub.subscribe().then(drain);
    expect(attempts).toBe(1);
    expect(result.error).toBeDefined();
  });

  it("respects custom nonRetryableStatuses", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      attempts++;
      return new Response("forbidden", { status: 403 });
    });

    const sub = new SSEStreamSubscription("http://example.test/sse", {
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
      nonRetryableStatuses: [403],
    });

    const result = await sub.subscribe().then(drain);
    expect(attempts).toBe(1);
    expect(result.error).toBeDefined();
  });

  it("retries on 503 (caller-tunable nonRetryableStatuses)", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      attempts++;
      if (attempts < 3) return new Response("unavailable", { status: 503 });
      return makeSSEResponse();
    });

    const sub = new SSEStreamSubscription("http://example.test/sse", {
      retryDelayMs: 1,
      maxRetryDelayMs: 5,
      // 503 is NOT in the default non-retryable set; it should retry.
    });

    const result = await sub.subscribe().then(drain);
    expect(attempts).toBe(3);
    expect(result.error).toBeUndefined();
    expect(result.chunks).toHaveLength(1);
  });

  it("applies jitter to backoff (delays vary across attempts)", async () => {
    const callTimes: number[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callTimes.push(performance.now());
      throw new TypeError("fetch failed");
    });

    const ac = new AbortController();
    const sub = new SSEStreamSubscription("http://example.test/sse", {
      signal: ac.signal,
      retryDelayMs: 50,
      maxRetryDelayMs: 50,
      retryJitter: 0.5, // 50% — final delay in [25ms, 50ms]
    });

    const promise = sub.subscribe().then(drain);
    await new Promise((r) => setTimeout(r, 600)); // allow ~10 attempts
    ac.abort();
    await promise;

    expect(callTimes.length).toBeGreaterThanOrEqual(5);

    // Compute inter-attempt gaps (skip the first since it has no prior).
    const gaps = callTimes.slice(1).map((t, i) => t - callTimes[i]!);
    // Without jitter all gaps would be ~50ms. With 50% jitter they
    // should land in [~25ms, ~50ms] and not all be identical.
    const min = Math.min(...gaps);
    const max = Math.max(...gaps);
    expect(min).toBeGreaterThanOrEqual(20); // a little slack for timer scheduling
    expect(max).toBeLessThanOrEqual(80);
    // Variance check — at least one gap should differ from another by
    // a measurable amount (rules out a deterministic-delay regression).
    expect(max - min).toBeGreaterThan(2);
  });
});

describe("SSEStreamSubscription v2 batch parsing — record kinds", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  type ParsedPart = { id: string; chunk: unknown; headers?: ReadonlyArray<readonly [string, string]> };

  // Build a v2 batch SSE response with the given records and close.
  function makeBatchResponse(
    records: Array<{
      body: string;
      seq_num: number;
      timestamp: number;
      headers?: Array<[string, string]>;
    }>
  ) {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`event: batch\ndata: ${JSON.stringify({ records })}\n\n`)
        );
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream", "X-Stream-Version": "v2" },
    });
  }

  async function drain(stream: ReadableStream<ParsedPart>) {
    const reader = stream.getReader();
    const parts: ParsedPart[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        reader.releaseLock();
        return parts;
      }
      parts.push(value as ParsedPart);
    }
  }

  it("data records flow through with headers and parsed body", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeBatchResponse([
        {
          body: JSON.stringify({ data: { type: "text-delta", delta: "hi" }, id: "p1" }),
          seq_num: 5,
          timestamp: 1700000000000,
          headers: [],
        },
      ])
    );
    const sub = new SSEStreamSubscription("http://x", { maxRetries: 0 });
    const parts = await sub.subscribe().then(drain);

    expect(parts).toHaveLength(1);
    expect(parts[0]!.id).toBe("5");
    expect(parts[0]!.chunk).toEqual({ type: "text-delta", delta: "hi" });
    expect(parts[0]!.headers).toEqual([]);
  });

  it("S2 command records (empty-name header) are filtered out", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeBatchResponse([
        {
          body: JSON.stringify({ data: { type: "text-delta", delta: "before" }, id: "p1" }),
          seq_num: 4,
          timestamp: 1700000000000,
          headers: [],
        },
        // Trim command record — empty-name header, opaque body.
        {
          body: "AAAAAAAAAAQ=",
          seq_num: 5,
          timestamp: 1700000000001,
          headers: [["", "trim"]],
        },
        {
          body: JSON.stringify({ data: { type: "text-delta", delta: "after" }, id: "p2" }),
          seq_num: 6,
          timestamp: 1700000000002,
          headers: [],
        },
      ])
    );
    const sub = new SSEStreamSubscription("http://x", { maxRetries: 0 });
    const parts = await sub.subscribe().then(drain);

    // Trim record stripped — only the two data records survive.
    expect(parts).toHaveLength(2);
    expect((parts[0]!.chunk as any).delta).toBe("before");
    expect((parts[1]!.chunk as any).delta).toBe("after");
  });

  it("trigger-control records flow with headers and undefined chunk", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeBatchResponse([
        {
          body: "",
          seq_num: 7,
          timestamp: 1700000000003,
          headers: [
            ["trigger-control", "turn-complete"],
            ["public-access-token", "eyJ..."],
          ],
        },
      ])
    );
    const sub = new SSEStreamSubscription("http://x", { maxRetries: 0 });
    const parts = await sub.subscribe().then(drain);

    // Control record passes through so consumers can route by header,
    // but its `chunk` is undefined (empty body).
    expect(parts).toHaveLength(1);
    expect(parts[0]!.chunk).toBeUndefined();
    expect(parts[0]!.headers).toEqual([
      ["trigger-control", "turn-complete"],
      ["public-access-token", "eyJ..."],
    ]);
  });

  it("malformed data record body does not crash; cursor still advances", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      makeBatchResponse([
        {
          body: "not json at all",
          seq_num: 8,
          timestamp: 1700000000004,
          headers: [],
        },
        {
          body: JSON.stringify({ data: { type: "text-delta", delta: "x" }, id: "p3" }),
          seq_num: 9,
          timestamp: 1700000000005,
          headers: [],
        },
      ])
    );
    const sub = new SSEStreamSubscription("http://x", { maxRetries: 0 });
    const parts = await sub.subscribe().then(drain);

    // Malformed record still propagates with undefined chunk (matches
    // control-record shape); next data record is fine.
    expect(parts).toHaveLength(2);
    expect(parts[0]!.chunk).toBeUndefined();
    expect((parts[1]!.chunk as any).delta).toBe("x");
  });
});
