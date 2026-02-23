import { AnyZodFetchOptions, ApiRequestOptions } from "../apiClient/core.js";
import { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import { Prettify } from "../types/utils.js";
import type { ManualWaitpointPromise } from "../waitpoints/index.js";

export type RealtimeStreamOperationOptions = {
  signal?: AbortSignal;
  target?: string;
  requestOptions?: AnyZodFetchOptions;
};

export interface RealtimeStreamsManager {
  pipe<T>(
    key: string,
    source: AsyncIterable<T> | ReadableStream<T>,
    options?: RealtimeStreamOperationOptions
  ): RealtimeStreamInstance<T>;

  append<TPart extends BodyInit>(
    key: string,
    part: TPart,
    options?: RealtimeStreamOperationOptions
  ): Promise<void>;
}

export interface RealtimeStreamInstance<T> {
  wait(): Promise<void>;
  get stream(): AsyncIterableStream<T>;
}

export interface StreamsWriter {
  wait(): Promise<void>;
}

export type RealtimeDefinedStream<TPart> = {
  id: string;
  pipe: (
    value: AsyncIterable<TPart> | ReadableStream<TPart>,
    options?: PipeStreamOptions
  ) => PipeStreamResult<TPart>;
  read: (runId: string, options?: ReadStreamOptions) => Promise<AsyncIterableStream<TPart>>;
  append: (value: TPart, options?: AppendStreamOptions) => Promise<void>;
  writer: (options: WriterStreamOptions<TPart>) => PipeStreamResult<TPart>;
};

export type InferStreamType<T> = T extends RealtimeDefinedStream<infer TPart> ? TPart : unknown;

/**
 * Options for appending data to a realtime stream.
 */
export type PipeStreamOptions = {
  /**
   * An AbortSignal that can be used to cancel the stream operation.
   * If the signal is aborted, the stream will be closed.
   */
  signal?: AbortSignal;
  /**
   * The target run ID to pipe the stream to. Can be:
   * - `"self"` - Pipe to the current run (default)
   * - `"parent"` - Pipe to the parent run
   * - `"root"` - Pipe to the root run
   * - A specific run ID string
   *
   * If not provided and not called from within a task, an error will be thrown.
   */
  target?: string;
  /**
   * Additional request options for the API call.
   */
  requestOptions?: ApiRequestOptions;
};

/**
 * The result of piping data to a realtime stream.
 *
 * @template T - The type of data chunks in the stream
 */
export type PipeStreamResult<T> = {
  /**
   * The original stream that was piped. You can consume this stream in your task
   * to process the data locally while it's also being piped to the realtime stream.
   */
  stream: AsyncIterableStream<T>;
  /**
   * A function that returns a promise which resolves when all data has been piped
   * to the realtime stream. Use this to wait for the stream to complete before
   * finishing your task.
   */
  waitUntilComplete: () => Promise<void>;
};

/**
 * Options for reading data from a realtime stream.
 */
export type ReadStreamOptions = {
  /**
   * An AbortSignal that can be used to cancel the stream reading operation.
   * If the signal is aborted, the stream will be closed.
   */
  signal?: AbortSignal;
  /**
   * The number of seconds to wait for new data to be available.
   * If no data arrives within the timeout, the stream will be closed.
   *
   * @default 60 seconds
   */
  timeoutInSeconds?: number;

  /**
   * The index to start reading from (1-based).
   * If not provided, the stream will start from the beginning.
   * Use this to resume reading from a specific position.
   *
   * @default 0 (start from beginning)
   */
  startIndex?: number;
};

/**
 * Options for appending data to a realtime stream.
 */
export type AppendStreamOptions = {
  /**
   * The target run ID to append the stream to. Can be:
   * - `"self"` - Pipe to the current run (default)
   * - `"parent"` - Pipe to the parent run
   * - `"root"` - Pipe to the root run
   * - A specific run ID string
   *
   * If not provided and not called from within a task, an error will be thrown.
   */
  target?: string;
  /**
   * Additional request options for the API call.
   */
  requestOptions?: ApiRequestOptions;
};

export type WriterStreamOptions<TPart> = Prettify<
  PipeStreamOptions & {
    execute: (options: {
      write: (part: TPart) => void;
      merge(stream: ReadableStream<TPart>): void;
    }) => Promise<void> | void;
  }
>;

// --- Input streams (inbound data to running tasks) ---

/**
 * A defined input stream that can receive typed data from external callers.
 *
 * Inside a task, use `.on()`, `.once()`, or `.peek()` to receive data.
 * Outside a task, use `.send()` to send data to a running task.
 */
export type RealtimeDefinedInputStream<TData> = {
  id: string;
  /**
   * Register a handler that fires every time data arrives on this input stream.
   * Returns a subscription object with an `.off()` method to unsubscribe.
   */
  on: (handler: (data: TData) => void | Promise<void>) => InputStreamSubscription;
  /**
   * Wait for the next piece of data on this input stream.
   * Resolves with the data when it arrives.
   */
  once: (options?: InputStreamOnceOptions) => Promise<TData>;
  /**
   * Non-blocking peek at the most recent data received on this input stream.
   * Returns `undefined` if no data has been received yet.
   */
  peek: () => TData | undefined;
  /**
   * Suspend the task until data arrives on this input stream.
   *
   * Unlike `.once()` which keeps the task process alive while waiting,
   * `.wait()` suspends the task entirely — freeing compute resources.
   * The task resumes when data is sent via `.send()`.
   *
   * Uses a waitpoint token internally. Can only be called inside a task.run().
   */
  wait: (options?: InputStreamWaitOptions) => ManualWaitpointPromise<TData>;
  /**
   * Send data to this input stream on a specific run.
   * This is used from outside the task (e.g., from your backend or another task).
   */
  send: (runId: string, data: TData, options?: SendInputStreamOptions) => Promise<void>;
};

export type InputStreamSubscription = {
  off: () => void;
};

export type InputStreamOnceOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type SendInputStreamOptions = {
  requestOptions?: ApiRequestOptions;
};

export type InputStreamWaitOptions = {
  /**
   * Maximum time to wait before the waitpoint times out.
   * Uses the same period format as `wait.createToken()`.
   * If the timeout is reached, the result will be `{ ok: false, error }`.
   *
   * @example "30s", "5m", "1h", "24h", "7d"
   */
  timeout?: string;

  /**
   * Idempotency key for the underlying waitpoint token.
   * If the same key is used again (and hasn't expired), the existing
   * waitpoint is reused. This means if the task retries, it will
   * resume waiting on the same waitpoint rather than creating a new one.
   */
  idempotencyKey?: string;

  /**
   * TTL for the idempotency key. After this period, the same key
   * will create a new waitpoint.
   */
  idempotencyKeyTTL?: string;

  /**
   * Tags for the underlying waitpoint token, useful for querying
   * and filtering waitpoints via `wait.listTokens()`.
   */
  tags?: string[];
};

export type InferInputStreamType<T> = T extends RealtimeDefinedInputStream<infer TData>
  ? TData
  : unknown;

/**
 * Internal record format for multiplexed input stream data on S2.
 * All input streams for a run share a single S2 stream, demuxed by `stream` field.
 */
export type InputStreamRecord = {
  stream: string;
  data: unknown;
  ts: number;
  id: string;
};
