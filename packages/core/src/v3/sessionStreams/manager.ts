import { ApiClient } from "../apiClient/index.js";
import {
  InputStreamOncePromise,
  InputStreamOnceResult,
  InputStreamTimeoutError,
} from "../inputStreams/types.js";
import { InputStreamOnceOptions } from "../realtimeStreams/types.js";
import { computeReconnectDelayMs } from "../utils/reconnectBackoff.js";
import { SessionChannelIO, SessionStreamManager } from "./types.js";
import { controlSubtype } from "./wireProtocol.js";

type SessionStreamHandler = (data: unknown) => void | Promise<void>;

type OnceWaiter = {
  resolve: (result: InputStreamOnceResult<unknown>) => void;
  reject: (error: Error) => void;
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
  private handlers = new Map<string, Set<SessionStreamHandler>>();
  private onceWaiters = new Map<string, OnceWaiter[]>();
  private buffer = new Map<string, unknown[]>();
  // Parallel to `buffer`: the SSE seq_num of each buffered record. Same
  // length and order as `buffer[key]`. Used so that when `once()` shifts
  // a buffered record into a waiter, the cursor (`lastDispatchedSeqNums`)
  // can advance to that record's seq. Kept as a separate map so the
  // existing `peek()` shape (returns `unknown`) stays unchanged.
  private bufferSeqNums = new Map<string, number[]>();
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
  // Highest seq_num that has been *consumed* (delivered to a once()
  // waiter or shifted off the buffer into a once() caller) on a channel.
  // Distinct from `seqNums`, which advances whenever any record is
  // received from SSE — even ones still sitting in the local buffer.
  // The committed-consume cursor is what gets persisted on the
  // turn-complete control record's `session-in-event-id` header so the
  // next worker boot can resume `.in` from this point without
  // re-delivering already-handled user messages.
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

  on(
    sessionId: string,
    io: SessionChannelIO,
    handler: SessionStreamHandler
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

    const buffered = this.buffer.get(key);
    if (buffered && buffered.length > 0) {
      for (const data of buffered) {
        this.#invokeHandler(handler, data);
      }
      this.buffer.delete(key);
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
    const key = keyFor(sessionId, io);

    this.explicitlyDisconnected.delete(key);
    this.#ensureTailConnected(sessionId, io);

    const buffered = this.buffer.get(key);
    if (buffered && buffered.length > 0) {
      const data = buffered.shift()!;
      const seqList = this.bufferSeqNums.get(key);
      const shiftedSeqNum = seqList?.shift();
      if (buffered.length === 0) {
        this.buffer.delete(key);
        this.bufferSeqNums.delete(key);
      }
      if (shiftedSeqNum !== undefined) {
        this.#advanceLastDispatched(key, shiftedSeqNum);
      }
      return new InputStreamOncePromise((resolve) => {
        resolve({ ok: true, output: data });
      });
    }

    return new InputStreamOncePromise<unknown>((resolve, reject) => {
      const waiter: OnceWaiter = { resolve, reject };

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

  peek(sessionId: string, io: SessionChannelIO): unknown | undefined {
    const buffered = this.buffer.get(keyFor(sessionId, io));
    if (buffered && buffered.length > 0) return buffered[0];
    return undefined;
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

  lastDispatchedSeqNum(sessionId: string, io: SessionChannelIO): number | undefined {
    return this.lastDispatchedSeqNums.get(keyFor(sessionId, io));
  }

  setLastDispatchedSeqNum(
    sessionId: string,
    io: SessionChannelIO,
    seqNum: number
  ): void {
    this.#advanceLastDispatched(keyFor(sessionId, io), seqNum);
  }

  #advanceLastDispatched(key: string, seqNum: number): void {
    const current = this.lastDispatchedSeqNums.get(key);
    if (current === undefined || seqNum > current) {
      this.lastDispatchedSeqNums.set(key, seqNum);
    }
  }

  setMinTimestamp(
    sessionId: string,
    io: SessionChannelIO,
    minTimestamp: number | undefined
  ): void {
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
      buffered.shift();
      const seqList = this.bufferSeqNums.get(key);
      const shiftedSeqNum = seqList?.shift();
      if (buffered.length === 0) {
        this.buffer.delete(key);
        this.bufferSeqNums.delete(key);
      }
      if (shiftedSeqNum !== undefined) {
        this.#advanceLastDispatched(key, shiftedSeqNum);
      }
      return true;
    }
    return false;
  }

  disconnectStream(sessionId: string, io: SessionChannelIO): void {
    const key = keyFor(sessionId, io);
    const tail = this.tails.get(key);
    const bufferedSize = this.buffer.get(key)?.length ?? 0;
    // Mark as explicitly disconnected BEFORE we abort, so the tail's
    // `.finally` reconnect path sees the flag when it runs (which can be
    // synchronous in the AbortError catch). Cleared on the next explicit
    // `on()`/`once()`.
    this.explicitlyDisconnected.add(key);
    if (tail) {
      tail.abortController.abort();
      this.tails.delete(key);
    }
    this.buffer.delete(key);
    this.bufferSeqNums.delete(key);
    // Reset the backoff counter so a future re-attach starts fresh —
    // an explicit disconnect is a deliberate teardown, not evidence of
    // a broken backend.
    this.reconnectAttempts.delete(key);
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
    this.bufferSeqNums.clear();
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
        // honor that — the caller (typically `session.in.wait()`) is
        // suspending the run and expects no records to be buffered or
        // delivered until a fresh `on()` / `once()` re-attaches. Without
        // this guard a run-level persistent handler (e.g. `chat.agent`'s
        // `stopInput.on(...)`) would auto-reconnect during the suspend
        // window, the resurrected tail would receive the same record the
        // waitpoint just delivered, and that record would land in the
        // buffer where the next turn's `messagesInput.on(...)` drains it
        // and runs a duplicate turn.
        if (this.explicitlyDisconnected.has(key)) {
          return;
        }

        const hasHandlers = this.handlers.has(key) && this.handlers.get(key)!.size > 0;
        const hasWaiters =
          this.onceWaiters.has(key) && this.onceWaiters.get(key)!.length > 0;
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
            const stillHasHandlers =
              this.handlers.has(key) && this.handlers.get(key)!.size > 0;
            const stillHasWaiters =
              this.onceWaiters.has(key) && this.onceWaiters.get(key)!.length > 0;
            if (!stillHasHandlers && !stillHasWaiters) return;
            this.#ensureTailConnected(sessionId, io);
          }, delayMs);
        }
      });
    this.tails.set(key, { abortController, promise });
  }

  async #runTail(
    sessionId: string,
    io: SessionChannelIO,
    signal: AbortSignal
  ): Promise<void> {
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
          if (Number.isFinite(seqNum)) {
            this.seqNums.set(key, seqNum);
          }

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
          this.#dispatch(key, data, Number.isFinite(seqNum) ? seqNum : undefined);
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

  #dispatch(key: string, data: unknown, seqNum: number | undefined): void {
    // Any record flowing through = healthy connection; reset the backoff
    // counter so the next disconnect starts fresh.
    this.reconnectAttempts.delete(key);

    const waiters = this.onceWaiters.get(key);
    if (waiters && waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (waiters.length === 0) this.onceWaiters.delete(key);
      if (waiter.timeoutHandle) clearTimeout(waiter.timeoutHandle);
      if (waiter.signal && waiter.abortHandler) {
        waiter.signal.removeEventListener("abort", waiter.abortHandler);
      }
      // Record was consumed directly by a waiter — advance the
      // committed-consume cursor immediately. Buffered-then-shifted
      // records advance the cursor in `once()` / `shiftBuffer()`.
      if (seqNum !== undefined) {
        this.#advanceLastDispatched(key, seqNum);
      }
      waiter.resolve({ ok: true, output: data });
      this.#invokeHandlers(key, data);
      return;
    }

    // Persistent handlers (e.g. `stopInput.on(...)`) get a copy of the chunk,
    // but they don't "consume" it — handlers usually filter by `kind` and
    // ignore chunks they don't care about. Buffer the chunk regardless so a
    // subsequent `once()` (e.g. `messagesInput.waitWithIdleTimeout` in
    // chat.agent's preload) can still pick up the same chunk that arrived
    // before its waiter was registered.
    this.#invokeHandlers(key, data);

    let buffered = this.buffer.get(key);
    if (!buffered) {
      buffered = [];
      this.buffer.set(key, buffered);
    }
    buffered.push(data);
    if (seqNum !== undefined) {
      let bufferedSeqs = this.bufferSeqNums.get(key);
      if (!bufferedSeqs) {
        bufferedSeqs = [];
        this.bufferSeqNums.set(key, bufferedSeqs);
      }
      bufferedSeqs.push(seqNum);
    }
  }

  #invokeHandlers(key: string, data: unknown): void {
    const handlers = this.handlers.get(key);
    if (!handlers) return;
    for (const handler of handlers) {
      this.#invokeHandler(handler, data);
    }
  }

  #invokeHandler(handler: SessionStreamHandler, data: unknown): void {
    try {
      const result = handler(data);
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
