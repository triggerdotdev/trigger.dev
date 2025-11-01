import {
  type ApiRequestOptions,
  realtimeStreams,
  taskContext,
  type RealtimeAppendStreamOptions,
  type RealtimeStreamInstance,
  mergeRequestOptions,
  accessoryAttributes,
  SemanticInternalAttributes,
  apiClientManager,
  AsyncIterableStream,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";
import { SpanStatusCode } from "@opentelemetry/api";

/**
 * Options for appending data to a realtime stream.
 */
export type AppendStreamOptions = {
  /**
   * An AbortSignal that can be used to cancel the stream operation.
   * If the signal is aborted, the stream will be closed.
   */
  signal?: AbortSignal;
  /**
   * The target run ID to append the stream to. Can be:
   * - `"self"` - Append to the current run (default)
   * - `"parent"` - Append to the parent run
   * - `"root"` - Append to the root run
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
 * The result of appending data to a realtime stream.
 *
 * @template T - The type of data chunks in the stream
 */
export type AppendStreamResult<T> = {
  /**
   * The original stream that was appended. You can consume this stream in your task
   * to process the data locally while it's also being sent to the realtime stream.
   */
  stream: AsyncIterableStream<T>;
  /**
   * A function that returns a promise which resolves when all data has been sent
   * to the realtime stream. Use this to wait for the stream to complete before
   * finishing your task.
   */
  waitUntilComplete: () => Promise<void>;
};

const DEFAULT_STREAM_KEY = "default";

/**
 * Appends data to a realtime stream using the default stream key (`"default"`).
 *
 * This is a convenience overload that allows you to append data without specifying a stream key.
 * The stream will be created/accessed with the key `"default"`.
 *
 * @template T - The type of data chunks in the stream
 * @param value - The stream of data to append. Can be an `AsyncIterable<T>` or `ReadableStream<T>`.
 * @param options - Optional configuration for the stream operation
 * @returns A promise that resolves to an object containing:
 *   - `stream`: The original stream (can be consumed in your task)
 *   - `waitUntilComplete`: A function that returns a promise resolving when the stream is fully sent
 *
 * @example
 * ```ts
 * import { streams } from "@trigger.dev/sdk/v3";
 *
 * // Stream OpenAI completion chunks to the default stream
 * const completion = await openai.chat.completions.create({
 *   model: "gpt-4",
 *   messages: [{ role: "user", content: "Hello" }],
 *   stream: true,
 * });
 *
 * const { waitUntilComplete } = await streams.append(completion);
 *
 * // Process the stream locally
 * for await (const chunk of completion) {
 *   console.log(chunk);
 * }
 *
 * // Wait for all chunks to be sent to the realtime stream
 * await waitUntilComplete();
 * ```
 */
function append<T>(
  value: AsyncIterable<T> | ReadableStream<T>,
  options?: AppendStreamOptions
): Promise<AppendStreamResult<T>>;
/**
 * Appends data to a realtime stream with a specific stream key.
 *
 * Use this overload when you want to use a custom stream key instead of the default.
 *
 * @template T - The type of data chunks in the stream
 * @param key - The unique identifier for this stream. If multiple streams use the same key,
 *   they will be merged into a single stream. Defaults to `"default"` if not provided.
 * @param value - The stream of data to append. Can be an `AsyncIterable<T>` or `ReadableStream<T>`.
 * @param options - Optional configuration for the stream operation
 * @returns A promise that resolves to an object containing:
 *   - `stream`: The original stream (can be consumed in your task)
 *   - `waitUntilComplete`: A function that returns a promise resolving when the stream is fully sent
 *
 * @example
 * ```ts
 * import { streams } from "@trigger.dev/sdk/v3";
 *
 * // Stream data to a specific stream key
 * const myStream = createAsyncGenerator();
 * const { waitUntilComplete } = await streams.append("my-custom-stream", myStream);
 *
 * // Process the stream locally
 * for await (const chunk of myStream) {
 *   console.log(chunk);
 * }
 *
 * // Wait for all chunks to be sent
 * await waitUntilComplete();
 * ```
 *
 * @example
 * ```ts
 * // Stream to a parent run
 * await streams.append("output", myStream, {
 *   target: "parent",
 * });
 * ```
 */
function append<T>(
  key: string,
  value: AsyncIterable<T> | ReadableStream<T>,
  options?: AppendStreamOptions
): Promise<AppendStreamResult<T>>;
async function append<T>(
  keyOrValue: string | AsyncIterable<T> | ReadableStream<T>,
  valueOrOptions?: AsyncIterable<T> | ReadableStream<T> | AppendStreamOptions,
  options?: AppendStreamOptions
): Promise<AppendStreamResult<T>> {
  // Handle overload: append(value, options?) or append(key, value, options?)
  let key: string;
  let value: AsyncIterable<T> | ReadableStream<T>;
  let opts: AppendStreamOptions | undefined;

  if (typeof keyOrValue === "string") {
    // append(key, value, options?)
    key = keyOrValue;
    value = valueOrOptions as AsyncIterable<T> | ReadableStream<T>;
    opts = options;
  } else {
    // append(value, options?)
    key = DEFAULT_STREAM_KEY;
    value = keyOrValue;
    opts = valueOrOptions as AppendStreamOptions | undefined;
  }
  const runId = getRunIdForOptions(opts);

  if (!runId) {
    throw new Error(
      "Could not determine the target run ID for the realtime stream. Please specify a target run ID using the `target` option or use this function from inside a task."
    );
  }

  const span = tracer.startSpan("streams.append()", {
    attributes: {
      key,
      runId,
      [SemanticInternalAttributes.ENTITY_TYPE]: "realtime-stream",
      [SemanticInternalAttributes.ENTITY_ID]: `${runId}:${key}`,
      [SemanticInternalAttributes.STYLE_ICON]: "streams",
      ...accessoryAttributes({
        items: [
          {
            text: key,
            variant: "normal",
          },
        ],
        style: "codepath",
      }),
    },
  });

  const requestOptions = mergeRequestOptions({}, opts?.requestOptions);

  try {
    const instance = await realtimeStreams.append(key, value, {
      signal: opts?.signal,
      target: runId,
      requestOptions,
    });

    instance.wait().finally(() => {
      span.end();
    });

    return {
      stream: instance.stream,
      waitUntilComplete: () => instance.wait(),
    };
  } catch (error) {
    // if the error is a signal abort error, we need to end the span but not record an exception
    if (error instanceof Error && error.name === "AbortError") {
      span.end();
      throw error;
    }

    if (error instanceof Error || typeof error === "string") {
      span.recordException(error);
    } else {
      span.recordException(String(error));
    }

    span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();

    throw error;
  }
}

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
 * Reads data from a realtime stream using the default stream key (`"default"`).
 *
 * This is a convenience overload that allows you to read from the default stream without
 * specifying a stream key. The stream will be accessed with the key `"default"`.
 *
 * @template T - The type of data chunks in the stream
 * @param runId - The unique identifier of the run to read the stream from
 * @param options - Optional configuration for reading the stream
 * @returns A promise that resolves to an `AsyncIterableStream<T>` that can be consumed
 *   using `for await...of` or as a `ReadableStream`.
 *
 * @example
 * ```ts
 * import { streams } from "@trigger.dev/sdk/v3";
 *
 * // Read from the default stream
 * const stream = await streams.read<string>(runId);
 *
 * for await (const chunk of stream) {
 *   console.log("Received chunk:", chunk);
 * }
 * ```
 *
 * @example
 * ```ts
 * // Read with custom timeout and starting position
 * const stream = await streams.read<string>(runId, {
 *   timeoutInSeconds: 120,
 *   startIndex: 10, // Start from the 10th chunk
 * });
 * ```
 */
function read<T>(runId: string, options?: ReadStreamOptions): Promise<AsyncIterableStream<T>>;
/**
 * Reads data from a realtime stream with a specific stream key.
 *
 * Use this overload when you want to read from a stream with a custom key.
 *
 * @template T - The type of data chunks in the stream
 * @param runId - The unique identifier of the run to read the stream from
 * @param key - The unique identifier of the stream to read from. Defaults to `"default"` if not provided.
 * @param options - Optional configuration for reading the stream
 * @returns A promise that resolves to an `AsyncIterableStream<T>` that can be consumed
 *   using `for await...of` or as a `ReadableStream`.
 *
 * @example
 * ```ts
 * import { streams } from "@trigger.dev/sdk/v3";
 *
 * // Read from a specific stream key
 * const stream = await streams.read<string>(runId, "my-custom-stream");
 *
 * for await (const chunk of stream) {
 *   console.log("Received chunk:", chunk);
 * }
 * ```
 *
 * @example
 * ```ts
 * // Read with signal for cancellation
 * const controller = new AbortController();
 * const stream = await streams.read<string>(runId, "my-stream", {
 *   signal: controller.signal,
 *   timeoutInSeconds: 30,
 * });
 *
 * // Cancel after 5 seconds
 * setTimeout(() => controller.abort(), 5000);
 * ```
 */
function read<T>(
  runId: string,
  key: string,
  options?: ReadStreamOptions
): Promise<AsyncIterableStream<T>>;
async function read<T>(
  runId: string,
  keyOrOptions?: string | ReadStreamOptions,
  options?: ReadStreamOptions
): Promise<AsyncIterableStream<T>> {
  // Handle overload: read(runId, options?) or read(runId, key, options?)
  let key: string;
  let opts: ReadStreamOptions | undefined;

  if (typeof keyOrOptions === "string") {
    // read(runId, key, options?)
    key = keyOrOptions;
    opts = options;
  } else {
    // read(runId, options?)
    key = DEFAULT_STREAM_KEY;
    opts = keyOrOptions;
  }

  // Rename to readStream for consistency with existing code
  return readStreamImpl(runId, key, opts);
}

async function readStreamImpl<T>(
  runId: string,
  key: string,
  options?: ReadStreamOptions
): Promise<AsyncIterableStream<T>> {
  const apiClient = apiClientManager.clientOrThrow();

  const span = tracer.startSpan("streams.read()", {
    attributes: {
      key,
      runId,
      [SemanticInternalAttributes.ENTITY_TYPE]: "realtime-stream",
      [SemanticInternalAttributes.ENTITY_ID]: `${runId}:${key}`,
      [SemanticInternalAttributes.ENTITY_METADATA]: JSON.stringify({
        startIndex: options?.startIndex,
      }),
      [SemanticInternalAttributes.STYLE_ICON]: "streams",
      ...accessoryAttributes({
        items: [
          {
            text: key,
            variant: "normal",
          },
        ],
        style: "codepath",
      }),
    },
  });

  return await apiClient.fetchStream(runId, key, {
    signal: options?.signal,
    timeoutInSeconds: options?.timeoutInSeconds ?? 60,
    lastEventId: options?.startIndex ? (options.startIndex - 1).toString() : undefined,
    onComplete: () => {
      span.end();
    },
    onError: (error) => {
      span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    },
  });
}

export const streams = {
  append,
  read,
};

function getRunIdForOptions(options?: RealtimeAppendStreamOptions): string | undefined {
  if (options?.target) {
    if (options.target === "parent") {
      return taskContext.ctx?.run?.parentTaskRunId;
    }

    if (options.target === "root") {
      return taskContext.ctx?.run?.rootTaskRunId;
    }

    if (options.target === "self") {
      return taskContext.ctx?.run?.id;
    }

    return options.target;
  }

  return taskContext.ctx?.run?.id;
}
