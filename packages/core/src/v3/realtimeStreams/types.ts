import { AnyZodFetchOptions, ApiRequestOptions } from "../apiClient/core.js";
import { AsyncIterableStream } from "../streams/asyncIterableStream.js";
import { Prettify } from "../types/utils.js";

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
  writer: (options: WriterStreamOptions<TPart>) => void;
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
