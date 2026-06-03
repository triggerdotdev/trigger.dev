import type { InputStreamManager, InputStreamOnceResult } from "../inputStreams/types.js";
import { InputStreamOncePromise, InputStreamTimeoutError } from "../inputStreams/types.js";
import type { InputStreamOnceOptions } from "../realtimeStreams/types.js";

type OnceWaiter = {
  resolve: (value: InputStreamOnceResult<unknown>) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
};

type Handler = (data: unknown) => void | Promise<void>;

/**
 * In-memory implementation of `InputStreamManager` for unit tests.
 *
 * Tests push data via the driver's `.send(streamId, data)` method. Any
 * pending `.once()` waiters resolve immediately, and all `.on()` handlers
 * fire synchronously (awaited if they return a promise).
 *
 * Use this alongside {@link runInMockTaskContext} — not directly.
 */
export class TestInputStreamManager implements InputStreamManager {
  private handlers = new Map<string, Set<Handler>>();
  private onceWaiters = new Map<string, OnceWaiter[]>();
  private latest = new Map<string, unknown>();
  private lastSeqNums = new Map<string, number>();
  // Buffered sends that arrived before a `.once()` waiter was registered.
  // `.once()` semantically means "wait for NEXT value" but tests often
  // send data before the task has had a chance to reach the wait point.
  // Buffering closes that race so the waiter picks up the pending send.
  private pendingSends = new Map<string, unknown[]>();

  setRunId(_runId: string, _streamsVersion?: string): void {
    // No-op — the test driver tracks nothing about runs
  }

  on(streamId: string, handler: Handler): { off: () => void } {
    if (!this.handlers.has(streamId)) {
      this.handlers.set(streamId, new Set());
    }
    this.handlers.get(streamId)!.add(handler);

    return {
      off: () => {
        this.handlers.get(streamId)?.delete(handler);
      },
    };
  }

  once(streamId: string, options?: InputStreamOnceOptions): InputStreamOncePromise<unknown> {
    return new InputStreamOncePromise<unknown>((resolve) => {
      if (options?.signal?.aborted) {
        resolve({
          ok: false,
          error: new InputStreamTimeoutError(streamId, options.timeoutMs ?? 0),
        });
        return;
      }

      // Pick up any buffered send that arrived before this waiter.
      const buffered = this.pendingSends.get(streamId);
      if (buffered && buffered.length > 0) {
        const next = buffered.shift();
        if (buffered.length === 0) this.pendingSends.delete(streamId);
        resolve({ ok: true, output: next });
        return;
      }

      const waiter: OnceWaiter = {
        resolve,
        signal: options?.signal,
      };

      if (options?.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          this.removeWaiter(streamId, waiter);
          resolve({
            ok: false,
            error: new InputStreamTimeoutError(streamId, options.timeoutMs!),
          });
        }, options.timeoutMs);
      }

      if (options?.signal) {
        const abortHandler = () => {
          this.removeWaiter(streamId, waiter);
          if (waiter.timer) clearTimeout(waiter.timer);
          resolve({
            ok: false,
            error: new InputStreamTimeoutError(streamId, options.timeoutMs ?? 0),
          });
        };
        waiter.abortHandler = abortHandler;
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      if (!this.onceWaiters.has(streamId)) {
        this.onceWaiters.set(streamId, []);
      }
      this.onceWaiters.get(streamId)!.push(waiter);
    });
  }

  peek(streamId: string): unknown | undefined {
    return this.latest.get(streamId);
  }

  lastSeqNum(streamId: string): number | undefined {
    return this.lastSeqNums.get(streamId);
  }

  setLastSeqNum(streamId: string, seqNum: number): void {
    this.lastSeqNums.set(streamId, seqNum);
  }

  shiftBuffer(_streamId: string): boolean {
    return false;
  }

  disconnectStream(_streamId: string): void {}

  clearHandlers(): void {
    this.handlers.clear();
  }

  reset(): void {
    // Cancel any pending waiters to avoid dangling promises leaking between tests
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
    this.latest.clear();
    this.lastSeqNums.clear();
    this.pendingSends.clear();
  }

  disconnect(): void {
    this.reset();
  }

  connectTail(_runId: string, _fromSeq?: number): void {}

  // ── Test driver API (not part of InputStreamManager interface) ──────────

  /**
   * Push data onto an input stream. Resolves pending `once()` waiters
   * and fires all `on()` handlers (awaiting async handlers).
   */
  async __sendFromTest(streamId: string, data: unknown): Promise<void> {
    this.latest.set(streamId, data);

    const waiters = this.onceWaiters.get(streamId);
    const handlers = this.handlers.get(streamId);
    const hasWaiters = waiters && waiters.length > 0;
    const hasHandlers = handlers && handlers.size > 0;

    // If nothing is listening yet, buffer so the next `.once()` call picks it up.
    if (!hasWaiters && !hasHandlers) {
      if (!this.pendingSends.has(streamId)) {
        this.pendingSends.set(streamId, []);
      }
      this.pendingSends.get(streamId)!.push(data);
      return;
    }

    if (hasWaiters) {
      // Drain every pending once() waiter — this mirrors the real manager's
      // behavior where the stream tail delivers the same record to all listeners.
      const pending = waiters!.splice(0);
      for (const w of pending) {
        if (w.timer) clearTimeout(w.timer);
        if (w.signal && w.abortHandler) {
          w.signal.removeEventListener("abort", w.abortHandler);
        }
        w.resolve({ ok: true, output: data });
      }
    }

    if (hasHandlers) {
      await Promise.all(
        Array.from(handlers!).map((h) => Promise.resolve().then(() => h(data)))
      );
    }
  }

  /**
   * Immediately resolve every pending `once()` waiter for a stream with a
   * timeout error. Used to simulate closed streams (e.g. `exitAfterPreloadIdle`).
   */
  __closeFromTest(streamId: string): void {
    const waiters = this.onceWaiters.get(streamId);
    if (!waiters) return;
    const pending = waiters.splice(0);
    for (const w of pending) {
      if (w.timer) clearTimeout(w.timer);
      if (w.signal && w.abortHandler) {
        w.signal.removeEventListener("abort", w.abortHandler);
      }
      w.resolve({
        ok: false,
        error: new InputStreamTimeoutError(streamId, 0),
      });
    }
  }

  private removeWaiter(streamId: string, waiter: OnceWaiter): void {
    const waiters = this.onceWaiters.get(streamId);
    if (!waiters) return;
    const idx = waiters.indexOf(waiter);
    if (idx >= 0) waiters.splice(idx, 1);
  }
}
