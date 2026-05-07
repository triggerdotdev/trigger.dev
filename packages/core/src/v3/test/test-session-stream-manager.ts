import {
  InputStreamOncePromise,
  InputStreamOnceResult,
  InputStreamTimeoutError,
} from "../inputStreams/types.js";
import type { InputStreamOnceOptions } from "../realtimeStreams/types.js";
import type {
  SessionChannelIO,
  SessionStreamManager,
} from "../sessionStreams/types.js";

type OnceWaiter = {
  resolve: (value: InputStreamOnceResult<unknown>) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
};

type Handler = (data: unknown) => void | Promise<void>;

function keyFor(sessionId: string, io: SessionChannelIO): string {
  return `${sessionId}:${io}`;
}

/**
 * In-memory implementation of `SessionStreamManager` for unit tests. Same
 * shape as {@link TestInputStreamManager} but keyed on `(sessionId, io)`.
 *
 * Tests push data via `__sendFromTest(sessionId, io, data)` — any pending
 * `once()` waiters resolve immediately, and all `on()` handlers fire (awaited
 * if they return a promise). Records that arrive before a listener is
 * registered are buffered so the first `once()` picks them up.
 */
export class TestSessionStreamManager implements SessionStreamManager {
  private handlers = new Map<string, Set<Handler>>();
  private onceWaiters = new Map<string, OnceWaiter[]>();
  private buffer = new Map<string, unknown[]>();
  private seqNums = new Map<string, number>();

  on(
    sessionId: string,
    io: SessionChannelIO,
    handler: Handler
  ): { off: () => void } {
    const key = keyFor(sessionId, io);

    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler);

    const buffered = this.buffer.get(key);
    if (buffered && buffered.length > 0) {
      for (const data of buffered) {
        this.invoke(handler, data);
      }
      this.buffer.delete(key);
    }

    return {
      off: () => {
        this.handlers.get(key)?.delete(handler);
      },
    };
  }

  once(
    sessionId: string,
    io: SessionChannelIO,
    options?: InputStreamOnceOptions
  ): InputStreamOncePromise<unknown> {
    const key = keyFor(sessionId, io);

    return new InputStreamOncePromise<unknown>((resolve) => {
      if (options?.signal?.aborted) {
        resolve({
          ok: false,
          error: new InputStreamTimeoutError(key, options.timeoutMs ?? 0),
        });
        return;
      }

      const buffered = this.buffer.get(key);
      if (buffered && buffered.length > 0) {
        const next = buffered.shift();
        if (buffered.length === 0) this.buffer.delete(key);
        resolve({ ok: true, output: next });
        return;
      }

      const waiter: OnceWaiter = { resolve, signal: options?.signal };

      if (options?.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.removeWaiter(key, waiter);
          resolve({
            ok: false,
            error: new InputStreamTimeoutError(key, options.timeoutMs!),
          });
        }, options.timeoutMs);
      }

      if (options?.signal) {
        const abortHandler = () => {
          this.removeWaiter(key, waiter);
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve({
            ok: false,
            error: new InputStreamTimeoutError(key, options.timeoutMs ?? 0),
          });
        };
        waiter.abortHandler = abortHandler;
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      let waiters = this.onceWaiters.get(key);
      if (!waiters) {
        waiters = [];
        this.onceWaiters.set(key, waiters);
      }
      waiters.push(waiter);
    });
  }

  peek(sessionId: string, io: SessionChannelIO): unknown | undefined {
    const buffered = this.buffer.get(keyFor(sessionId, io));
    if (buffered && buffered.length > 0) return buffered[0];
    return undefined;
  }

  lastSeqNum(sessionId: string, io: SessionChannelIO): number | undefined {
    return this.seqNums.get(keyFor(sessionId, io));
  }

  setLastSeqNum(sessionId: string, io: SessionChannelIO, seqNum: number): void {
    this.seqNums.set(keyFor(sessionId, io), seqNum);
  }

  setMinTimestamp(
    _sessionId: string,
    _io: SessionChannelIO,
    _minTimestamp: number | undefined
  ): void {
    // No filter applied in tests; the test harness drives records directly
    // and the chat.agent retry path is exercised separately.
  }

  shiftBuffer(sessionId: string, io: SessionChannelIO): boolean {
    const key = keyFor(sessionId, io);
    const buffered = this.buffer.get(key);
    if (buffered && buffered.length > 0) {
      buffered.shift();
      if (buffered.length === 0) this.buffer.delete(key);
      return true;
    }
    return false;
  }

  disconnectStream(_sessionId: string, _io: SessionChannelIO): void {
    // no-op — no real SSE tail in tests
  }

  clearHandlers(): void {
    this.handlers.clear();
  }

  reset(): void {
    for (const waiters of this.onceWaiters.values()) {
      for (const w of waiters) {
        if (w.timer) clearTimeout(w.timer);
        if (w.signal && w.abortHandler) {
          w.signal.removeEventListener("abort", w.abortHandler);
        }
      }
    }
    this.onceWaiters.clear();
    this.handlers.clear();
    this.buffer.clear();
    this.seqNums.clear();
  }

  disconnect(): void {
    this.reset();
  }

  // ── Test driver API (not part of SessionStreamManager interface) ──────

  /**
   * Push a record onto the given channel.
   *
   * Dispatch rules — similar to the production manager, but with a tweak
   * that makes unit tests deterministic:
   *
   * 1. **Handlers always observe** (like production). A session-level `.on`
   *    is a filter-observer — it fires every time a record arrives,
   *    regardless of whether a `.once` waiter is also active.
   * 2. **First waiter consumes** the record if present (like production).
   * 3. **If no waiter, the record is buffered for the next `.once` call.**
   *    Production discards records that only match handlers — but in
   *    production the SSE tail introduces enough latency that the next
   *    `.once` is usually registered before the next record arrives. Tests
   *    send synchronously right after `turn-complete`, so without this
   *    buffer the next `waitWithIdleTimeout` would race and lose the
   *    message. The buffer is the only deviation from production semantics.
   */
  async __sendFromTest(
    sessionId: string,
    io: SessionChannelIO,
    data: unknown
  ): Promise<void> {
    const key = keyFor(sessionId, io);

    const handlers = this.handlers.get(key);
    if (handlers && handlers.size > 0) {
      await Promise.all(
        Array.from(handlers).map((h) => Promise.resolve().then(() => h(data)))
      );
    }

    const waiters = this.onceWaiters.get(key);
    if (waiters && waiters.length > 0) {
      const w = waiters.shift()!;
      if (waiters.length === 0) this.onceWaiters.delete(key);
      if (w.timer) clearTimeout(w.timer);
      if (w.signal && w.abortHandler) {
        w.signal.removeEventListener("abort", w.abortHandler);
      }
      w.resolve({ ok: true, output: data });
      return;
    }

    let buffered = this.buffer.get(key);
    if (!buffered) {
      buffered = [];
      this.buffer.set(key, buffered);
    }
    buffered.push(data);
  }

  /**
   * Immediately resolve every pending `once()` waiter for the given channel
   * with a timeout error. Simulates a closed stream (e.g. session closed).
   */
  __closeFromTest(sessionId: string, io: SessionChannelIO): void {
    const key = keyFor(sessionId, io);
    const waiters = this.onceWaiters.get(key);
    if (!waiters) return;
    const pending = waiters.splice(0);
    for (const w of pending) {
      if (w.timer) clearTimeout(w.timer);
      if (w.signal && w.abortHandler) {
        w.signal.removeEventListener("abort", w.abortHandler);
      }
      w.resolve({
        ok: false,
        error: new InputStreamTimeoutError(key, 0),
      });
    }
  }

  private invoke(handler: Handler, data: unknown): void {
    try {
      const result = handler(data);
      if (result && typeof result === "object" && "catch" in result) {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Never let a handler error break test state
    }
  }

  private removeWaiter(key: string, waiter: OnceWaiter): void {
    const waiters = this.onceWaiters.get(key);
    if (!waiters) return;
    const idx = waiters.indexOf(waiter);
    if (idx >= 0) waiters.splice(idx, 1);
  }
}
