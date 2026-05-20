import { InputStreamOnceOptions } from "../realtimeStreams/types.js";
import {
  InputStreamOncePromise,
  InputStreamOnceResult,
  InputStreamTimeoutError,
} from "../inputStreams/types.js";

/**
 * Re-export the run-scoped input stream once-promise machinery so callers
 * depending on sessionStreams don't also need to import from inputStreams.
 * Both APIs return the same shape.
 */
export { InputStreamOncePromise, InputStreamTimeoutError };
export type { InputStreamOnceResult };

export type SessionChannelIO = "out" | "in";

/**
 * Manager for Session channel reads: a session-scoped parallel to
 * {@link InputStreamManager} keyed on `(sessionId, io)` instead of
 * `(runId, streamId)`. Used by {@link SessionChannel} to implement
 * `.on` / `.once` / `.peek` / `.wait` / `.waitWithIdleTimeout`.
 */
export interface SessionStreamManager {
  /** Register a handler that fires every time data arrives on the given channel. */
  on(
    sessionId: string,
    io: SessionChannelIO,
    handler: (data: unknown) => void | Promise<void>
  ): { off: () => void };

  /** Wait for the next record on the given channel (buffered or live). */
  once(
    sessionId: string,
    io: SessionChannelIO,
    options?: InputStreamOnceOptions
  ): InputStreamOncePromise<unknown>;

  /** Non-blocking peek at the head of the channel buffer. */
  peek(sessionId: string, io: SessionChannelIO): unknown | undefined;

  /** Last S2 sequence number seen on the given channel. */
  lastSeqNum(sessionId: string, io: SessionChannelIO): number | undefined;

  /** Advance the last-seen sequence number (prevents SSE replay after `.wait` resume). */
  setLastSeqNum(sessionId: string, io: SessionChannelIO, seqNum: number): void;

  /**
   * Highest sequence number that has been *consumed* on the channel —
   * delivered to a `once()` waiter or shifted off the buffer into one.
   * Distinct from {@link lastSeqNum}, which advances on every received
   * record regardless of whether anything consumed it. Used by
   * `chat.agent` to persist the `.in` resume cursor on each
   * `turn-complete` control record so the next worker boot can resume
   * the channel from this point without replaying processed messages.
   */
  lastDispatchedSeqNum(sessionId: string, io: SessionChannelIO): number | undefined;

  /**
   * Seed the committed-consume cursor at worker boot — e.g. from the
   * `session-in-event-id` header on the latest `turn-complete` on
   * `.out`. Monotonic: only ever advances forward, never backwards.
   */
  setLastDispatchedSeqNum(
    sessionId: string,
    io: SessionChannelIO,
    seqNum: number
  ): void;

  /**
   * Set a per-stream lower-bound SSE timestamp. Records whose timestamp
   * is `<= minTimestamp` are dropped before dispatch. Used by chat.agent
   * on OOM-retry boot to skip session.in records belonging to turns
   * that already completed on the prior attempt.
   *
   * Pass `undefined` to clear the filter.
   */
  setMinTimestamp(
    sessionId: string,
    io: SessionChannelIO,
    minTimestamp: number | undefined
  ): void;

  /** Remove and discard the first buffered record. Returns true if one was removed. */
  shiftBuffer(sessionId: string, io: SessionChannelIO): boolean;

  /** Abort the SSE tail and clear the buffer. Called before `.wait` suspends. */
  disconnectStream(sessionId: string, io: SessionChannelIO): void;

  /** Clear all `.on` handlers; abort tails without pending once-waiters. */
  clearHandlers(): void;

  /** Reset state between task executions. */
  reset(): void;

  /** Disconnect every tail. */
  disconnect(): void;
}
