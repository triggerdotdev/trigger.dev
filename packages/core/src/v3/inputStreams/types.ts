import { InputStreamOnceOptions } from "../realtimeStreams/types.js";

export class InputStreamTimeoutError extends Error {
  constructor(
    public readonly streamId: string,
    public readonly timeoutMs: number
  ) {
    super(`Timeout waiting for input stream "${streamId}" after ${timeoutMs}ms`);
    this.name = "InputStreamTimeoutError";
  }
}

export type InputStreamOnceResult<TData> =
  | { ok: true; output: TData }
  | { ok: false; error: InputStreamTimeoutError };

export class InputStreamOncePromise<TData> extends Promise<InputStreamOnceResult<TData>> {
  constructor(
    executor: (
      resolve: (
        value: InputStreamOnceResult<TData> | PromiseLike<InputStreamOnceResult<TData>>
      ) => void,
      reject: (reason?: any) => void
    ) => void
  ) {
    super(executor);
  }

  unwrap(): Promise<TData> {
    return this.then((result) => {
      if (result.ok) {
        return result.output;
      } else {
        throw result.error;
      }
    });
  }
}

export interface InputStreamManager {
  /**
   * Set the current run ID and streams version. The tail connection will be
   * established lazily when `on()` or `once()` is first called, but only
   * for v2 (S2-backed) realtime streams.
   */
  setRunId(runId: string, streamsVersion?: string): void;

  /**
   * Register a handler that fires every time data arrives on the given input stream.
   * Handlers are automatically cleaned up when the task run completes.
   * Returns `{ off }` for early unsubscription if needed.
   */
  on(streamId: string, handler: (data: unknown) => void | Promise<void>): { off: () => void };

  /**
   * Wait for the next piece of data on the given input stream.
   * Returns a result object `{ ok, output }` or `{ ok, error }`.
   * Chain `.unwrap()` to get the data directly or throw on timeout.
   */
  once(streamId: string, options?: InputStreamOnceOptions): InputStreamOncePromise<unknown>;

  /**
   * Non-blocking peek at the most recent data on the given input stream.
   */
  peek(streamId: string): unknown | undefined;

  /**
   * The last S2 sequence number seen for the given input stream.
   * Used by `.wait()` to tell the server where to check for existing data.
   */
  lastSeqNum(streamId: string): number | undefined;

  /**
   * Advance the last-seen S2 sequence number for the given input stream.
   * Used after `.wait()` resumes to prevent the SSE tail from replaying
   * the record that was consumed via the waitpoint path.
   */
  setLastSeqNum(streamId: string, seqNum: number): void;

  /**
   * Remove and discard the first buffered item for the given input stream.
   * Used after `.wait()` resumes to remove the duplicate that the SSE tail
   * buffered while the waitpoint was being completed via a separate path.
   * Returns true if an item was removed, false if the buffer was empty.
   */
  shiftBuffer(streamId: string): boolean;

  /**
   * Disconnect the SSE tail and clear the buffer for a specific input stream.
   * Used before suspending via `.wait()` so the tail doesn't buffer duplicates
   * of data that will be delivered through the waitpoint path.
   */
  disconnectStream(streamId: string): void;

  /**
   * Clear all persistent `.on()` handlers and abort tails that have no remaining once waiters.
   * Called automatically when a task run completes.
   */
  clearHandlers(): void;

  /**
   * Reset state between task executions.
   */
  reset(): void;

  /**
   * Disconnect any active tails / connections.
   */
  disconnect(): void;

  /**
   * Connect a tail to receive input stream records for the given run.
   */
  connectTail(runId: string, fromSeq?: number): void;
}
