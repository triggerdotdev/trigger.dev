import type { InputStreamOnceResult } from "../inputStreams/types.js";
import { InputStreamOncePromise, InputStreamTimeoutError } from "../inputStreams/types.js";
import type { InputStreamOnceOptions } from "../realtimeStreams/types.js";
import type {
  SessionChannelIO,
  SessionStreamManager,
  SessionStreamRecord,
  SessionStreamRecordPredicate,
} from "../sessionStreams/types.js";

type OnceWaiter = {
  resolve: (value: InputStreamOnceResult<SessionStreamRecord>) => void;
  predicate?: SessionStreamRecordPredicate;
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
  private buffer = new Map<string, SessionStreamRecord[]>();
  private seqNums = new Map<string, number>();
  private dispatchedSeqNums = new Map<string, number>();
  private unconsumedSeqNums = new Map<string, Set<number>>();
  private cursorBarriers = new Map<string, SessionStreamRecordPredicate>();

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
      const kept: SessionStreamRecord[] = [];
      for (const record of buffered) {
        let consumed = false;
        try {
          consumed = handler(record.data) === true;
        } catch {
          // Never let a handler error break test state
        }
        if (consumed) {
          this.#advanceLastDispatched(key, record.seqNum);
        } else {
          kept.push(record);
        }
      }
      if (kept.length > 0) {
        this.buffer.set(key, kept);
      } else {
        this.buffer.delete(key);
      }
      this.#drainOnceWaitersFromBuffer(key);
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
    const recordPromise = this.onceRecord(sessionId, io, options);
    return new InputStreamOncePromise<unknown>((resolve, reject) => {
      recordPromise.then((result) => {
        resolve(result.ok ? { ok: true, output: result.output.data } : result);
      }, reject);
    });
  }

  onceRecord(
    sessionId: string,
    io: SessionChannelIO,
    options?: InputStreamOnceOptions
  ): InputStreamOncePromise<SessionStreamRecord> {
    return this.#onceRecord(sessionId, io, undefined, options);
  }

  onceRecordWhere(
    sessionId: string,
    io: SessionChannelIO,
    predicate: SessionStreamRecordPredicate,
    options?: InputStreamOnceOptions
  ): InputStreamOncePromise<SessionStreamRecord> {
    return this.#onceRecord(sessionId, io, predicate, options);
  }

  #onceRecord(
    sessionId: string,
    io: SessionChannelIO,
    predicate: SessionStreamRecordPredicate | undefined,
    options?: InputStreamOnceOptions
  ): InputStreamOncePromise<SessionStreamRecord> {
    const key = keyFor(sessionId, io);

    return new InputStreamOncePromise<SessionStreamRecord>((resolve) => {
      if (options?.signal?.aborted) {
        resolve({
          ok: false,
          error: new InputStreamTimeoutError(key, options.timeoutMs ?? 0),
        });
        return;
      }

      const buffered = this.buffer.get(key);
      if (buffered && buffered.length > 0) {
        const next = buffered[0]!;
        if (!predicate || predicate(next)) {
          buffered.shift();
          if (buffered.length === 0) this.buffer.delete(key);
          this.#advanceLastDispatched(key, next.seqNum);
          this.#drainOnceWaitersFromBuffer(key);
          resolve({ ok: true, output: next });
          return;
        }
      }

      if (options?.timeoutMs === 0) {
        resolve({
          ok: false,
          error: new InputStreamTimeoutError(key, 0),
        });
        return;
      }

      const waiter: OnceWaiter = { resolve, predicate, signal: options?.signal };

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
    return this.peekRecord(sessionId, io)?.data;
  }

  setCursorBarrier(
    sessionId: string,
    io: SessionChannelIO,
    predicate: SessionStreamRecordPredicate | undefined
  ): void {
    const key = keyFor(sessionId, io);
    if (predicate) this.cursorBarriers.set(key, predicate);
    else this.cursorBarriers.delete(key);
  }

  peekRecord(sessionId: string, io: SessionChannelIO): SessionStreamRecord | undefined {
    return this.buffer.get(keyFor(sessionId, io))?.[0];
  }

  lastSeqNum(sessionId: string, io: SessionChannelIO): number | undefined {
    return this.seqNums.get(keyFor(sessionId, io));
  }

  setLastSeqNum(sessionId: string, io: SessionChannelIO, seqNum: number): void {
    this.seqNums.set(keyFor(sessionId, io), seqNum);
  }

  consumeRecord(sessionId: string, io: SessionChannelIO, seqNum: number): void {
    const key = keyFor(sessionId, io);
    const buffered = this.buffer.get(key);
    const index = buffered?.findIndex((record) => record.seqNum === seqNum) ?? -1;

    if (buffered && index !== -1) {
      buffered.splice(index, 1);
      if (buffered.length === 0) {
        this.buffer.delete(key);
      }
    }

    this.#advanceLastDispatched(key, seqNum);
    this.#drainOnceWaitersFromBuffer(key);
  }

  lastDispatchedSeqNum(sessionId: string, io: SessionChannelIO): number | undefined {
    const key = keyFor(sessionId, io);
    const highWatermark = this.dispatchedSeqNums.get(key);
    if (highWatermark === undefined) return undefined;

    const unconsumedSeqNums = this.unconsumedSeqNums.get(key);
    if (!unconsumedSeqNums || unconsumedSeqNums.size === 0) return highWatermark;

    let earliestUnconsumedSeqNum = Infinity;
    for (const seqNum of unconsumedSeqNums) {
      earliestUnconsumedSeqNum = Math.min(earliestUnconsumedSeqNum, seqNum);
    }

    const safeCursor = Math.min(highWatermark, earliestUnconsumedSeqNum - 1);
    return safeCursor >= 0 ? safeCursor : undefined;
  }

  setLastDispatchedSeqNum(sessionId: string, io: SessionChannelIO, seqNum: number): void {
    if (!Number.isFinite(seqNum)) return;

    this.#advanceLastDispatched(keyFor(sessionId, io), seqNum);
  }

  #advanceLastDispatched(key: string, seqNum: number): void {
    this.#removeUnconsumedRecord(key, seqNum);
    if (!Number.isFinite(seqNum)) return;
    const current = this.dispatchedSeqNums.get(key);
    if (current === undefined || seqNum > current) {
      this.dispatchedSeqNums.set(key, seqNum);
    }
  }

  #isCursorBarrier(key: string, record: SessionStreamRecord): boolean {
    const predicate = this.cursorBarriers.get(key);
    if (!predicate) return true;
    try {
      return predicate(record);
    } catch {
      return true;
    }
  }

  #markUnconsumedRecord(key: string, seqNum: number): void {
    if (!Number.isFinite(seqNum)) return;

    let unconsumedSeqNums = this.unconsumedSeqNums.get(key);
    if (!unconsumedSeqNums) {
      unconsumedSeqNums = new Set();
      this.unconsumedSeqNums.set(key, unconsumedSeqNums);
    }
    unconsumedSeqNums.add(seqNum);
  }

  #removeUnconsumedRecord(key: string, seqNum: number): void {
    const unconsumedSeqNums = this.unconsumedSeqNums.get(key);
    unconsumedSeqNums?.delete(seqNum);
    if (unconsumedSeqNums?.size === 0) {
      this.unconsumedSeqNums.delete(key);
    }
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
      const record = buffered.shift()!;
      if (buffered.length === 0) this.buffer.delete(key);
      this.#advanceLastDispatched(key, record.seqNum);
      this.#drainOnceWaitersFromBuffer(key);
      return true;
    }
    return false;
  }

  disconnectStream(_sessionId: string, _io: SessionChannelIO): void {
    // The production manager keeps buffered records reachable across a
    // waitpoint suspension. The exact waitpoint record is removed on resume.
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
    this.dispatchedSeqNums.clear();
    this.unconsumedSeqNums.clear();
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
  async __sendFromTest(
    sessionId: string,
    io: SessionChannelIO,
    data: unknown,
    metadata?: { id?: string; seqNum?: number }
  ): Promise<void> {
    const key = keyFor(sessionId, io);
    const seqNum = metadata?.seqNum ?? (this.seqNums.get(key) ?? -1) + 1;
    if (!Number.isFinite(seqNum)) {
      throw new TypeError("Test Session stream records require a finite sequence number");
    }
    const record: SessionStreamRecord = {
      id: metadata?.id ?? `test-record-${seqNum}`,
      seqNum,
      data,
    };
    const lastSeqNum = this.seqNums.get(key);
    if (lastSeqNum === undefined || seqNum > lastSeqNum) {
      this.seqNums.set(key, seqNum);
    }

    const existingBuffer = this.buffer.get(key);
    const waiter =
      existingBuffer && existingBuffer.length > 0 ? undefined : this.#takeOnceWaiter(key, record);
    if (waiter) {
      this.#advanceLastDispatched(key, record.seqNum);
      waiter.resolve({ ok: true, output: record });
      await this.#invokeHandlers(key, record.data);
      return;
    }

    const consumed = await this.#invokeHandlers(key, record.data);
    if (consumed) {
      this.#advanceLastDispatched(key, record.seqNum);
      return;
    }

    // Re-check waiters: handler invocation above is awaited (unlike the
    // synchronous production dispatch), and the runtime commonly registers
    // its next `once()` during that window — e.g. the turn loop reaching
    // `waitWithIdleTimeout` while a handler settles. Without this second
    // look the record would be buffered while the fresh waiter hangs.
    const bufferedAfterHandlers = this.buffer.get(key);
    const lateWaiter =
      bufferedAfterHandlers && bufferedAfterHandlers.length > 0
        ? undefined
        : this.#takeOnceWaiter(key, record);
    if (lateWaiter) {
      this.#advanceLastDispatched(key, record.seqNum);
      lateWaiter.resolve({ ok: true, output: record });
      return;
    }

    let buffered = this.buffer.get(key);
    if (!buffered) {
      buffered = [];
      this.buffer.set(key, buffered);
    }
    buffered.push(record);
    if (this.#isCursorBarrier(key, record)) {
      this.#markUnconsumedRecord(key, record.seqNum);
    }
    this.#drainOnceWaitersFromBuffer(key);
  }

  #takeOnceWaiter(key: string, record: SessionStreamRecord): OnceWaiter | undefined {
    const waiters = this.onceWaiters.get(key);
    if (!waiters) return undefined;

    const index = waiters.findIndex((waiter) => {
      if (!waiter.predicate) return true;
      try {
        return waiter.predicate(record);
      } catch {
        return false;
      }
    });
    if (index === -1) return undefined;

    const [waiter] = waiters.splice(index, 1);
    if (waiters.length === 0) this.onceWaiters.delete(key);
    if (waiter!.timer) clearTimeout(waiter!.timer);
    if (waiter!.signal && waiter!.abortHandler) {
      waiter!.signal.removeEventListener("abort", waiter!.abortHandler);
    }
    return waiter;
  }

  #drainOnceWaitersFromBuffer(key: string): void {
    const buffered = this.buffer.get(key);
    while (buffered && buffered.length > 0) {
      const record = buffered[0]!;
      const waiter = this.#takeOnceWaiter(key, record);
      if (!waiter) return;

      buffered.shift();
      if (buffered.length === 0) this.buffer.delete(key);
      this.#advanceLastDispatched(key, record.seqNum);
      waiter.resolve({ ok: true, output: record });
    }
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
