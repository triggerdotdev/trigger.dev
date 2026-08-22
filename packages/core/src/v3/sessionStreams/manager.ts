import type { ApiClient } from "../apiClient/index.js";
import type { InputStreamOnceResult } from "../inputStreams/types.js";
import { InputStreamOncePromise, InputStreamTimeoutError } from "../inputStreams/types.js";
import type { InputStreamOnceOptions } from "../realtimeStreams/types.js";
import { computeReconnectDelayMs } from "../utils/reconnectBackoff.js";
import type {
  SessionChannelIO,
  SessionStreamManager,
  SessionStreamRecord,
  SessionStreamRecordPredicate,
} from "./types.js";
import { controlSubtype } from "./wireProtocol.js";

// A handler that synchronously returns `true` CONSUMES the record: it is
// not buffered for a later `once()` and the committed-consume cursor
// advances past it. Anything else (void, a Promise) leaves the record
// available to other consumers. See `SessionStreamManager.on` in types.ts.
type SessionStreamHandler = (data: unknown) => void | boolean | Promise<void>;

/**
 * A handler that sees the whole record rather than just its payload. Consumers
 * that route by sequence number need the metadata, the same reason
 * `onceRecord` exists alongside `once`.
 */
type SessionStreamRecordHandler = (record: SessionStreamRecord) => void | boolean | Promise<void>;

type RegisteredHandler =
  | { kind: "data"; fn: SessionStreamHandler }
  | { kind: "record"; fn: SessionStreamRecordHandler };

type OnceWaiter = {
  resolve: (result: InputStreamOnceResult<SessionStreamRecord>) => void;
  reject: (error: Error) => void;
  predicate?: SessionStreamRecordPredicate;
  timeoutHandle?: ReturnType<typeof setTimeout>;
  // The abort signal and its handler are tracked on the waiter so any
  // resolution path (dispatch / timeout / explicit removal) can detach
  // the listener. Without this, a long-lived `AbortSignal` reused across
  // many `once()` calls accumulates listeners — `{ once: true }` only
  // self-clears if the signal actually aborts.
  signal?: AbortSignal;
  abortHandler?: () => void;
};

type TailState = {
  abortController: AbortController;
  promise: Promise<void>;
};

function keyFor(sessionId: string, io: SessionChannelIO): string {
  return `${sessionId}:${io}`;
}

/**
 * Session-scoped parallel to {@link StandardInputStreamManager}. Keeps the
 * same buffer / once-waiter / tail lifecycle, but keyed on
 * `(sessionId, io)` and subscribing via
 * {@link ApiClient.subscribeToSessionStream} instead of the run input
 * stream SSE.
 */
export class StandardSessionStreamManager implements SessionStreamManager {
  private handlers = new Map<string, Set<RegisteredHandler>>();
  private onceWaiters = new Map<string, OnceWaiter[]>();
  private buffer = new Map<string, SessionStreamRecord[]>();
  private tails = new Map<string, TailState>();
  // Per-stream lower-bound timestamp filter. When set, records whose
  // SSE timestamp is <= the bound are dropped before dispatch — used by
  // chat.agent on OOM-retry boot to skip session.in records belonging
  // to turns that already completed on the prior attempt. The filter
  // is consulted in `runTail`'s `onPart` so the buffer never sees the
  // dropped records.
  private minTimestamps = new Map<string, number>();
  // Keys that were explicitly torn down by `disconnectStream`. The tail's
  // `.finally` reconnect path checks this so a long-lived persistent handler
  // (e.g. `chat.agent`'s run-level `stopInput.on(...)`) doesn't silently
  // resurrect the tail mid-`session.in.wait()` and re-deliver the record
  // that's already being delivered out-of-band via the waitpoint.
  private explicitlyDisconnected = new Set<string>();
  private seqNums = new Map<string, number>();
  // Sequence numbers for records that were delivered but not consumed.
  // Kept separately from `buffer` so the committed cursor can be calculated
  // without depending on buffer traversal.
  private unconsumedSeqNums = new Map<string, Set<number>>();

  // High-water mark of seq_nums that have been *consumed* (delivered to a
  // once() waiter or shifted off the buffer into a once() caller) on a channel.
  // Distinct from `seqNums`, which advances whenever any record is
  // received from SSE — even ones still sitting in the local buffer.
  // `lastDispatchedSeqNum()` clamps this behind any unconsumed barrier before
  // it is persisted on a turn-complete control record.
  private lastDispatchedSeqNums = new Map<string, number>();
  // Reconnect attempt counter per key. Drives the exponential backoff
  // applied by `#ensureTailConnected`'s `.finally` so a persistent
  // backend failure (auth rejection, 5xx, DNS, etc.) doesn't reconnect
  // in a tight loop. Reset to 0 by `#dispatch` whenever a real record
  // flows through — any successful traffic is taken as a healthy
  // connection.
  private reconnectAttempts = new Map<string, number>();

  constructor(
    private apiClient: ApiClient,
    private baseUrl: string,
    private debug: boolean = false
  ) {}

  on(sessionId: string, io: SessionChannelIO, handler: SessionStreamHandler): { off: () => void } {
    return this.#register(sessionId, io, { kind: "data", fn: handler });
  }

  /**
   * Register a handler that receives the full record, including its sequence
   * number. Same consume semantics as {@link on}: returning `true` consumes.
   */
  onRecord(
    sessionId: string,
    io: SessionChannelIO,
    handler: SessionStreamRecordHandler
  ): { off: () => void } {
    return this.#register(sessionId, io, { kind: "record", fn: handler });
  }

  #register(
    sessionId: string,
    io: SessionChannelIO,
    handler: RegisteredHandler
  ): { off: () => void } {
    const key = keyFor(sessionId, io);

    let handlerSet = this.handlers.get(key);
    if (!handlerSet) {
      handlerSet = new Set();
      this.handlers.set(key, handlerSet);
    }
    handlerSet.add(handler);

    // Explicit re-attach clears the "explicitly disconnected" suppression
    // so the tail can subscribe again now that callers want delivery back.
    this.explicitlyDisconnected.delete(key);
    this.#ensureTailConnected(sessionId, io);

    // Selective drain: offer each buffered record to the new handler and
    // remove ONLY the ones it consumed (returned `true` — e.g. the
    // messages facade for message-kind records). Consumed records advance
    // the committed-consume cursor, so a worker using `messagesInput.on()`
    // for user-message delivery persists a `.in` cursor that matches what
    // the handler processed. Records the handler did not consume (other
    // kinds) STAY buffered for a future `once()` or a different handler —
    // a blind drain here either swallowed them (delivered to a handler
    // that filtered them out, then deleted) or re-delivered already-
    // processed messages into every newly attached per-turn handler,
    // duplicating turns.
    const buffered = this.buffer.get(key);
    if (buffered && buffered.length > 0) {
      const keptRecords: SessionStreamRecord[] = [];
      for (const record of buffered) {
        const consumed = this.#invokeHandler(handler, record);
        if (consumed) {
          this.#advanceLastDispatched(key, record.seqNum);
        } else {
          keptRecords.push(record);
        }
      }
      if (keptRecords.length > 0) {
        this.buffer.set(key, keptRecords);
      } else {
        this.buffer.delete(key);
      }
      this.#drainOnceWaitersFromBuffer(key);
    }

    return {
      off: () => {
        handlerSet?.delete(handler);
        if (handlerSet?.size === 0) {
          this.handlers.delete(key);
        }
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

    if (options?.timeoutMs === 0) {
      const record = this.#takeBufferedRecord(key, predicate);
      return new InputStreamOncePromise((resolve) => {
        resolve(
          record
            ? { ok: true, output: record }
            : { ok: false, error: new InputStreamTimeoutError(key, 0) }
        );
      });
    }

    this.explicitlyDisconnected.delete(key);
    this.#ensureTailConnected(sessionId, io);

    const record = this.#takeBufferedRecord(key, predicate);
    if (record) {
      return new InputStreamOncePromise((resolve) => {
        resolve({ ok: true, output: record });
      });
    }

    return new InputStreamOncePromise<SessionStreamRecord>((resolve, reject) => {
      const waiter: OnceWaiter = { resolve, reject, predicate };

      if (options?.signal) {
        if (options.signal.aborted) {
          reject(new Error("Aborted"));
          return;
        }
        const abortHandler = () => {
          if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
          this.#removeOnceWaiter(key, waiter);
          reject(new Error("Aborted"));
        };
        waiter.signal = options.signal;
        waiter.abortHandler = abortHandler;
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      if (options?.timeoutMs) {
        waiter.timeoutHandle = setTimeout(() => {
          this.#removeOnceWaiter(key, waiter);
          resolve({
            ok: false,
            error: new InputStreamTimeoutError(key, options.timeoutMs!),
          });
        }, options.timeoutMs);
      }

      let waiters = this.onceWaiters.get(key);
      if (!waiters) {
        waiters = [];
        this.onceWaiters.set(key, waiters);
      }
      waiters.push(waiter);
    });
  }

  #takeBufferedRecord(
    key: string,
    predicate: SessionStreamRecordPredicate | undefined
  ): SessionStreamRecord | undefined {
    const buffered = this.buffer.get(key);
    if (!buffered || buffered.length === 0) return undefined;

    const record = buffered[0]!;
    if (predicate && !predicate(record)) return undefined;

    buffered.shift();
    if (buffered.length === 0) {
      this.buffer.delete(key);
    }
    this.#advanceLastDispatched(key, record.seqNum);
    this.#drainOnceWaitersFromBuffer(key);
    return record;
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
    const key = keyFor(sessionId, io);
    const current = this.seqNums.get(key);
    if (current === undefined || seqNum > current) {
      this.seqNums.set(key, seqNum);
    }
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
    const highWatermark = this.lastDispatchedSeqNums.get(key);
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
    const current = this.lastDispatchedSeqNums.get(key);
    if (current === undefined || seqNum > current) {
      this.lastDispatchedSeqNums.set(key, seqNum);
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

  setMinTimestamp(sessionId: string, io: SessionChannelIO, minTimestamp: number | undefined): void {
    const key = keyFor(sessionId, io);
    if (minTimestamp === undefined) {
      this.minTimestamps.delete(key);
    } else {
      this.minTimestamps.set(key, minTimestamp);
    }
  }

  shiftBuffer(sessionId: string, io: SessionChannelIO): boolean {
    const key = keyFor(sessionId, io);
    const buffered = this.buffer.get(key);
    if (buffered && buffered.length > 0) {
      const record = buffered.shift()!;
      if (buffered.length === 0) {
        this.buffer.delete(key);
      }
      this.#advanceLastDispatched(key, record.seqNum);
      this.#drainOnceWaitersFromBuffer(key);
      return true;
    }
    return false;
  }

  disconnectStream(sessionId: string, io: SessionChannelIO): void {
    const key = keyFor(sessionId, io);
    const tail = this.tails.get(key);
    // Mark as explicitly disconnected BEFORE we abort, so the tail's
    // `.finally` reconnect path sees the flag when it runs (which can be
    // synchronous in the AbortError catch). Cleared on the next explicit
    // `on()`/`once()`.
    this.explicitlyDisconnected.add(key);
    if (tail) {
      tail.abortController.abort();
      this.tails.delete(key);
    }
    // Reset the backoff counter so a future re-attach starts fresh —
    // an explicit disconnect is a deliberate teardown, not evidence of
    // a broken backend.
    this.reconnectAttempts.delete(key);
  }

  /**
   * Re-open a channel that `disconnectStream` closed, without registering a
   * new consumer. A single long-lived reader (the session channel router) has
   * to be able to bring its own tail back after a suspend, and re-attaching
   * its handler just to clear the suppression flag would replay the buffer at
   * it.
   */
  reconnectStream(sessionId: string, io: SessionChannelIO): void {
    const key = keyFor(sessionId, io);
    this.explicitlyDisconnected.delete(key);
    this.#ensureTailConnected(sessionId, io);
  }

  clearHandlers(): void {
    this.handlers.clear();

    for (const [key, tail] of this.tails) {
      const hasWaiters = this.onceWaiters.has(key) && this.onceWaiters.get(key)!.length > 0;
      if (!hasWaiters) {
        tail.abortController.abort();
        this.tails.delete(key);
      }
    }
  }

  /**
   * Tear down all active tails. Does NOT clear handlers or `onceWaiters`,
   * so any registered listener will trigger an auto-reconnect (with
   * backoff) the moment it sees no live tail — by design, so a transient
   * network blip recovers without the caller re-subscribing. Use
   * `reset()` if you want a full clean state with no resurrection, or
   * `disconnectStream(sessionId, io)` for a single channel that should
   * stay down until a fresh `on()` / `once()` attaches.
   */
  disconnect(): void {
    for (const [, tail] of this.tails) {
      tail.abortController.abort();
    }
    this.tails.clear();
  }

  reset(): void {
    this.disconnect();
    this.seqNums.clear();
    this.lastDispatchedSeqNums.clear();
    this.unconsumedSeqNums.clear();
    this.minTimestamps.clear();
    this.handlers.clear();
    this.reconnectAttempts.clear();

    for (const [, waiters] of this.onceWaiters) {
      for (const waiter of waiters) {
        if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
        if (waiter.signal && waiter.abortHandler) {
          waiter.signal.removeEventListener("abort", waiter.abortHandler);
        }
        waiter.reject(new Error("Session stream manager reset"));
      }
    }
    this.onceWaiters.clear();
    this.buffer.clear();
  }

  #ensureTailConnected(sessionId: string, io: SessionChannelIO): void {
    const key = keyFor(sessionId, io);
    if (this.tails.has(key)) return;

    const abortController = new AbortController();
    const promise = this.#runTail(sessionId, io, abortController.signal)
      .catch((error) => {
        if (this.debug) {
          console.error(`[SessionStreamManager] Tail error for "${key}":`, error);
        }
      })
      .finally(() => {
        this.tails.delete(key);

        // If the tail was torn down explicitly via `disconnectStream`,
        // honor that until a fresh `on()` / `once()` re-attaches. Existing
        // buffered records stay available across the suspension, but a
        // run-level handler must not reconnect and receive another copy of
        // the record being delivered through the waitpoint.
        if (this.explicitlyDisconnected.has(key)) {
          return;
        }

        const hasHandlers = this.handlers.has(key) && this.handlers.get(key)!.size > 0;
        const hasWaiters = this.onceWaiters.has(key) && this.onceWaiters.get(key)!.length > 0;
        if (hasHandlers || hasWaiters) {
          // Exponential backoff with jitter. 1s base, doubling each
          // attempt, capped at 30s. Without this, a persistent backend
          // failure (auth rejected, 5xx, DNS) reconnects in a tight loop
          // because `#runTail`'s error path only logs. `#dispatch` resets
          // the counter on every successful record, so transient blips
          // don't accumulate.
          const attempt = this.reconnectAttempts.get(key) ?? 0;
          this.reconnectAttempts.set(key, attempt + 1);
          const delayMs = computeReconnectDelayMs(attempt);
          setTimeout(() => {
            // Guards: a fresh `on()` during the wait may already have
            // re-attached the tail; explicit disconnect or absence of
            // handlers/waiters means we should stay quiet.
            if (this.tails.has(key)) return;
            if (this.explicitlyDisconnected.has(key)) return;
            const stillHasHandlers = this.handlers.has(key) && this.handlers.get(key)!.size > 0;
            const stillHasWaiters =
              this.onceWaiters.has(key) && this.onceWaiters.get(key)!.length > 0;
            if (!stillHasHandlers && !stillHasWaiters) return;
            this.#ensureTailConnected(sessionId, io);
          }, delayMs);
        }
      });
    this.tails.set(key, { abortController, promise });
  }

  async #runTail(sessionId: string, io: SessionChannelIO, signal: AbortSignal): Promise<void> {
    const key = keyFor(sessionId, io);
    try {
      const lastSeq = this.seqNums.get(key);
      // Dispatch is driven from `onPart` (not the for-await loop) so each
      // record reaches dispatch with its full SSE metadata in scope —
      // specifically the timestamp, which we need for the per-stream
      // min-timestamp filter. The for-await loop below just drains the
      // pipeThrough output to keep the source flowing.
      const stream = await this.apiClient.subscribeToSessionStream<unknown>(sessionId, io, {
        signal,
        baseUrl: this.baseUrl,
        timeoutInSeconds: 600,
        lastEventId: lastSeq !== undefined ? String(lastSeq) : undefined,
        onPart: (part) => {
          if (signal.aborted) return;
          const seqNum = parseInt(part.id, 10);
          if (!Number.isFinite(seqNum)) return;
          this.seqNums.set(key, seqNum);

          // Trigger control records (turn-complete, upgrade-required)
          // are dispatched out-of-band via `onControl` — they're not
          // consumer-facing data. Skip the data dispatch path.
          if (controlSubtype(part.headers)) {
            return;
          }

          // Min-timestamp filter: drop records older than (or at) the
          // bound. Used to skip already-processed records on OOM-retry
          // boot.
          const minTs = this.minTimestamps.get(key);
          if (minTs !== undefined && part.timestamp <= minTs) {
            return;
          }

          let data: unknown = part.chunk;
          if (typeof data === "string") {
            try {
              data = JSON.parse(data);
            } catch {
              // keep as string
            }
          }
          this.#dispatch(key, {
            id: part.recordId ?? part.id,
            seqNum,
            data,
          });
        },
        onComplete: () => {
          if (this.debug) {
            console.log(`[SessionStreamManager] Tail completed for "${key}"`);
          }
        },
        onError: (error) => {
          if (this.debug) {
            console.error(`[SessionStreamManager] Tail error for "${key}":`, error);
          }
        },
      });

      // Drain to keep the pipeThrough flowing. Records were already
      // dispatched in `onPart`, so the body here is a no-op.
      for await (const _record of stream) {
        if (signal.aborted) break;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return;
      throw error;
    }
  }

  #dispatch(key: string, record: SessionStreamRecord): void {
    // Any record flowing through = healthy connection; reset the backoff
    // counter so the next disconnect starts fresh.
    this.reconnectAttempts.delete(key);

    const existingBuffer = this.buffer.get(key);
    const waiter =
      existingBuffer && existingBuffer.length > 0 ? undefined : this.#takeOnceWaiter(key, record);
    if (waiter) {
      // Record was consumed directly by a waiter — advance the
      // committed-consume cursor immediately. Buffered-then-shifted
      // records advance the cursor in `once()` / `shiftBuffer()`.
      this.#advanceLastDispatched(key, record.seqNum);
      waiter.resolve({ ok: true, output: record });
      this.#invokeHandlers(key, record);
      return;
    }

    // Persistent handlers get a copy of the chunk. A handler that
    // synchronously returns `true` CONSUMES it (e.g. the messages facade
    // for message-kind records): the record must not also be buffered, or
    // the next `on()` attach / `once()` would deliver it a second time —
    // in chat.agent's turn loop that duplicated user messages into a
    // second turn. Records no handler consumed (e.g. a message arriving
    // while only the stop facade is attached during preload) are buffered
    // so a subsequent `once()` can still pick them up.
    const consumed = this.#invokeHandlers(key, record);
    if (consumed) {
      this.#advanceLastDispatched(key, record.seqNum);
      return;
    }

    let buffered = this.buffer.get(key);
    if (!buffered) {
      buffered = [];
      this.buffer.set(key, buffered);
    }
    buffered.push(record);
    this.#markUnconsumedRecord(key, record.seqNum);
    this.#drainOnceWaitersFromBuffer(key);
  }

  #takeOnceWaiter(key: string, record: SessionStreamRecord): OnceWaiter | undefined {
    const waiters = this.onceWaiters.get(key);
    if (!waiters) return undefined;

    const index = waiters.findIndex((waiter) => {
      if (!waiter.predicate) return true;
      try {
        return waiter.predicate(record);
      } catch (error) {
        if (this.debug) {
          console.error("[SessionStreamManager] Record predicate error:", error);
        }
        return false;
      }
    });
    if (index === -1) return undefined;

    const [waiter] = waiters.splice(index, 1);
    if (waiters.length === 0) this.onceWaiters.delete(key);
    if (waiter!.timeoutHandle) clearTimeout(waiter!.timeoutHandle);
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

  /** Returns true when any handler consumed the record. All handlers are invoked regardless. */
  #invokeHandlers(key: string, record: SessionStreamRecord): boolean {
    const handlers = this.handlers.get(key);
    if (!handlers) return false;
    let consumed = false;
    for (const handler of handlers) {
      if (this.#invokeHandler(handler, record)) {
        consumed = true;
      }
    }
    return consumed;
  }

  /** Returns true when the handler synchronously consumed the record (returned `true`). */
  #invokeHandler(handler: RegisteredHandler, record: SessionStreamRecord): boolean {
    try {
      const result = handler.kind === "record" ? handler.fn(record) : handler.fn(record.data);
      if (result === true) return true;
      if (result && typeof result === "object" && "catch" in result) {
        (result as Promise<void>).catch((error) => {
          if (this.debug) {
            console.error("[SessionStreamManager] Handler error:", error);
          }
        });
      }
    } catch (error) {
      if (this.debug) {
        console.error("[SessionStreamManager] Handler error:", error);
      }
    }
    return false;
  }

  #removeOnceWaiter(key: string, waiter: OnceWaiter): void {
    // Centralized cleanup — both timeout and explicit abort paths funnel
    // through here, so detach the abort listener once instead of at every
    // callsite. The dispatch path doesn't go through this method (the
    // waiter is shifted off inline), so it detaches the listener there.
    if (waiter.signal && waiter.abortHandler) {
      waiter.signal.removeEventListener("abort", waiter.abortHandler);
    }
    const waiters = this.onceWaiters.get(key);
    if (!waiters) return;
    const index = waiters.indexOf(waiter);
    if (index !== -1) waiters.splice(index, 1);
    if (waiters.length === 0) this.onceWaiters.delete(key);
  }
}
