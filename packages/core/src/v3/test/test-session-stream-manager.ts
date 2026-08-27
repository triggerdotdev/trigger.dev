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
type RecordHandler = (record: SessionStreamRecord) => void | boolean | Promise<void>;

type RegisteredHandler = { kind: "data"; fn: Handler } | { kind: "record"; fn: RecordHandler };

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
  private handlers = new Map<string, Set<RegisteredHandler>>();
  private onceWaiters = new Map<string, OnceWaiter[]>();
  private buffer = new Map<string, SessionStreamRecord[]>();
  private seqNums = new Map<string, number>();
  private dispatchedSeqNums = new Map<string, number>();

  on(sessionId: string, io: SessionChannelIO, handler: Handler): { off: () => void } {
    return this.#register(sessionId, io, { kind: "data", fn: handler });
  }

  onRecord(sessionId: string, io: SessionChannelIO, handler: RecordHandler): { off: () => void } {
    return this.#register(sessionId, io, { kind: "record", fn: handler });
  }

  #register(
    sessionId: string,
    io: SessionChannelIO,
    handler: RegisteredHandler
  ): { off: () => void } {
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
          consumed = this.#callHandler(handler, record) === true;
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
    return this.dispatchedSeqNums.get(keyFor(sessionId, io));
  }

  setLastDispatchedSeqNum(sessionId: string, io: SessionChannelIO, seqNum: number): void {
    if (!Number.isFinite(seqNum)) return;

    this.#advanceLastDispatched(keyFor(sessionId, io), seqNum);
  }

  #advanceLastDispatched(key: string, seqNum: number): void {
    if (!Number.isFinite(seqNum)) return;
    const current = this.dispatchedSeqNums.get(key);
    if (current === undefined || seqNum > current) {
      this.dispatchedSeqNums.set(key, seqNum);
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
      await this.#invokeHandlers(key, record);
      return;
    }

    const { consumed, settled } = this.#invokeHandlersSync(key, record);
    if (!consumed) {
      let buffered = this.buffer.get(key);
      if (!buffered) {
        buffered = [];
        this.buffer.set(key, buffered);
      }
      buffered.push(record);
      this.#drainOnceWaitersFromBuffer(key);
    } else {
      this.#advanceLastDispatched(key, record.seqNum);
    }

    await settled;
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
  async #invokeHandlers(key: string, record: SessionStreamRecord): Promise<boolean> {
    const { consumed, settled } = this.#invokeHandlersSync(key, record);
    await settled;
    return consumed;
  }

  /**
   * Decide consumption synchronously, exactly like the production dispatch,
   * and hand back a promise for any async handler work so callers can still
   * await it. Splitting the decision from the awaiting is what keeps a handler
   * registered mid-dispatch from seeing an inconsistent buffer.
   */
  #invokeHandlersSync(
    key: string,
    record: SessionStreamRecord
  ): { consumed: boolean; settled: Promise<unknown> } {
    const handlers = this.handlers.get(key);
    if (!handlers || handlers.size === 0) {
      return { consumed: false, settled: Promise.resolve() };
    }

    let consumed = false;
    const pending: Array<Promise<unknown>> = [];
    for (const handler of Array.from(handlers)) {
      try {
        const result = this.#callHandler(handler, record);
        if (result === true) {
          consumed = true;
          continue;
        }
        if (result) pending.push(Promise.resolve(result).catch(() => {}));
      } catch {
        continue;
      }
    }
    return { consumed, settled: Promise.all(pending) };
  }

  #callHandler(
    handler: RegisteredHandler,
    record: SessionStreamRecord
  ): void | boolean | Promise<void> {
    return handler.kind === "record" ? handler.fn(record) : handler.fn(record.data);
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
