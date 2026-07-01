import type {
  InputStreamOnceResult} from "../inputStreams/types.js";
import {
  InputStreamOncePromise,
  InputStreamTimeoutError,
} from "../inputStreams/types.js";
import type { InputStreamOnceOptions } from "../realtimeStreams/types.js";
import type { SessionChannelIO, SessionStreamManager } from "../sessionStreams/types.js";

type OnceWaiter = {
  resolve: (value: InputStreamOnceResult<unknown>) => void;
  timer?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
};

// Same contract as the production manager: a handler that synchronously
// returns `true` CONSUMES the record (not buffered, not re-delivered on a
// future `on()` attach). See `SessionStreamManager.on` in types.ts.
type Handler = (data: unknown) => void | boolean | Promise<void>;

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

  on(sessionId: string, io: SessionChannelIO, handler: Handler): { off: () => void } {
    const key = keyFor(sessionId, io);

    let set = this.handlers.get(key);
    if (!set) {
      set = new Set();
      this.handlers.set(key, set);
    }
    set.add(handler);

    // Selective drain, matching the production manager: offer each
    // buffered record to the new handler and remove ONLY the ones it
    // consumed (returned `true`). Records the handler filtered out (other
    // kinds) stay buffered for a future `once()`. This is the corrected
    // form of two historical bugs: a blind drain swallowed boot-phase user
    // messages into the stop facade (which ignores `kind: "message"`),
    // and no-drain-at-all let production re-deliver already-processed
    // messages into every newly attached per-turn handler.
    const buffered = this.buffer.get(key);
    if (buffered && buffered.length > 0) {
      const kept: unknown[] = [];
      for (const data of buffered) {
        let consumed = false;
        try {
          consumed = handler(data) === true;
        } catch {
          // Never let a handler error break test state
        }
        if (!consumed) kept.push(data);
      }
      if (kept.length > 0) {
        this.buffer.set(key, kept);
      } else {
        this.buffer.delete(key);
      }
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

  lastDispatchedSeqNum(_sessionId: string, _io: SessionChannelIO): number | undefined {
    // The test harness drives records via `__sendFromTest` without seq
    // numbers, so the committed-consume cursor stays undefined. Tests
    // that need cursor behaviour exercise it via the real manager.
    return undefined;
  }

  setLastDispatchedSeqNum(_sessionId: string, _io: SessionChannelIO, _seqNum: number): void {
    // no-op — see comment on `lastDispatchedSeqNum`.
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
   * Dispatch rules — same as the production manager:
   *
   * 1. **A pending `.once` waiter consumes first.** Handlers still observe
   *    a copy.
   * 2. **Otherwise handlers observe.** A handler that synchronously
   *    returns `true` consumes the record (kind-filtering facades do this
   *    for the kinds they own) — it is NOT buffered.
   * 3. **Records no one consumed are buffered** for the next `.once` call
   *    or the next consuming `on()` attach.
   *
   * Handler promises are awaited before resolving so test code can rely
   * on async handler work having settled by the time `__sendFromTest`
   * resolves. Consumption is decided on the synchronous return value,
   * exactly like production.
   */
  async __sendFromTest(sessionId: string, io: SessionChannelIO, data: unknown): Promise<void> {
    const key = keyFor(sessionId, io);

    const waiters = this.onceWaiters.get(key);
    if (waiters && waiters.length > 0) {
      const w = waiters.shift()!;
      if (waiters.length === 0) this.onceWaiters.delete(key);
      if (w.timer) clearTimeout(w.timer);
      if (w.signal && w.abortHandler) {
        w.signal.removeEventListener("abort", w.abortHandler);
      }
      w.resolve({ ok: true, output: data });
      await this.#invokeHandlers(key, data);
      return;
    }

    const consumed = await this.#invokeHandlers(key, data);
    if (consumed) return;

    // Re-check waiters: handler invocation above is awaited (unlike the
    // synchronous production dispatch), and the runtime commonly registers
    // its next `once()` during that window — e.g. the turn loop reaching
    // `waitWithIdleTimeout` while a handler settles. Without this second
    // look the record would be buffered while the fresh waiter hangs.
    const lateWaiters = this.onceWaiters.get(key);
    if (lateWaiters && lateWaiters.length > 0) {
      const w = lateWaiters.shift()!;
      if (lateWaiters.length === 0) this.onceWaiters.delete(key);
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
   * Invoke all handlers; resolves once any returned promises settle.
   * Returns true when any handler synchronously consumed the record.
   * Wrapped per-handler so a throwing/rejecting handler doesn't poison
   * Promise.all and break unrelated test state.
   */
  async #invokeHandlers(key: string, data: unknown): Promise<boolean> {
    const handlers = this.handlers.get(key);
    if (!handlers || handlers.size === 0) return false;

    let consumed = false;
    await Promise.all(
      Array.from(handlers).map(async (h) => {
        try {
          const result = h(data);
          if (result === true) {
            consumed = true;
            return;
          }
          await result;
        } catch {
          // Never let a handler error break test state
        }
      })
    );
    return consumed;
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

  private removeWaiter(key: string, waiter: OnceWaiter): void {
    const waiters = this.onceWaiters.get(key);
    if (!waiters) return;
    const idx = waiters.indexOf(waiter);
    if (idx >= 0) waiters.splice(idx, 1);
  }
}
