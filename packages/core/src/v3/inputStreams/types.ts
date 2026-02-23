import { InputStreamOnceOptions } from "../realtimeStreams/types.js";

export interface InputStreamManager {
  /**
   * Set the current run ID and streams version. The tail connection will be
   * established lazily when `on()` or `once()` is first called, but only
   * for v2 (S2-backed) realtime streams.
   */
  setRunId(runId: string, streamsVersion?: string): void;

  /**
   * Register a handler that fires every time data arrives on the given input stream.
   */
  on(streamId: string, handler: (data: unknown) => void | Promise<void>): { off: () => void };

  /**
   * Wait for the next piece of data on the given input stream.
   */
  once(streamId: string, options?: InputStreamOnceOptions): Promise<unknown>;

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
