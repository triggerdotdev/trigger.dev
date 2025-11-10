import {
  type ApiRequestOptions,
  realtimeStreams,
  taskContext,
  type RealtimeStreamOperationOptions,
  mergeRequestOptions,
  accessoryAttributes,
  SemanticInternalAttributes,
  apiClientManager,
  AsyncIterableStream,
  WriterStreamOptions,
  PipeStreamOptions,
  PipeStreamResult,
  ReadStreamOptions,
  AppendStreamOptions,
  RealtimeDefinedStream,
  InferStreamType,
} from "@trigger.dev/core/v3";
import { tracer } from "./tracer.js";
import { SpanStatusCode } from "@opentelemetry/api";

const DEFAULT_STREAM_KEY = "default";

/**
 * Pipes data to a realtime stream using the default stream key (`"default"`).
 *
 * This is a convenience overload that allows you to pipe data without specifying a stream key.
 * The stream will be created/accessed with the key `"default"`.
 *
 * @template T - The type of data chunks in the stream
 * @param value - The stream of data to pipe from. Can be an `AsyncIterable<T>` or `ReadableStream<T>`.
 * @param options - Optional configuration for the stream operation
 * @returns A promise that resolves to an object containing:
 *   - `stream`: The original stream (can be consumed in your task)
 *   - `waitUntilComplete`: A function that returns a promise resolving when the stream is fully sent
 *
 * @example
 * ```ts
 * import { streams } from "@trigger.dev/sdk";
 *
 * // Stream OpenAI completion chunks to the default stream
 * const completion = await openai.chat.completions.create({
 *   model: "gpt-4",
 *   messages: [{ role: "user", content: "Hello" }],
 *   stream: true,
 * });
 *
 * const { waitUntilComplete } = await streams.pipe(completion);
 *
 * // Process the stream locally
 * for await (const chunk of completion) {
 *   console.log(chunk);
 * }
 *
 * // Or alternatievely wait for all chunks to be sent to the realtime stream
 * await waitUntilComplete();
 * ```
 */
function pipe<T>(
  value: AsyncIterable<T> | ReadableStream<T>,
  options?: PipeStreamOptions
): PipeStreamResult<T>;
/**
 * Pipes data to a realtime stream with a specific stream key.
 *
 * Use this overload when you want to use a custom stream key instead of the default.
 *
 * @template T - The type of data chunks in the stream
 * @param key - The unique identifier for this stream. If multiple streams use the same key,
 *   they will be merged into a single stream. Defaults to `"default"` if not provided.
 * @param value - The stream of data to pipe from. Can be an `AsyncIterable<T>` or `ReadableStream<T>`.
 * @param options - Optional configuration for the stream operation
 * @returns A promise that resolves to an object containing:
 *   - `stream`: The original stream (can be consumed in your task)
 *   - `waitUntilComplete`: A function that returns a promise resolving when the stream is fully sent
 *
 * @example
 * ```ts
 * import { streams } from "@trigger.dev/sdk";
 *
 * // Stream data to a specific stream key
 * const myStream = createAsyncGenerator();
 * const { waitUntilComplete } = await streams.pipe("my-custom-stream", myStream);
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
 * await streams.pipe("output", myStream, {
 *   target: "parent",
 * });
 * ```
 */
function pipe<T>(
  key: string,
  value: AsyncIterable<T> | ReadableStream<T>,
  options?: PipeStreamOptions
): PipeStreamResult<T>;
function pipe<T>(
  keyOrValue: string | AsyncIterable<T> | ReadableStream<T>,
  valueOrOptions?: AsyncIterable<T> | ReadableStream<T> | PipeStreamOptions,
  options?: PipeStreamOptions
): PipeStreamResult<T> {
  // Handle overload: pipe(value, options?) or pipe(key, value, options?)
  let key: string;
  let value: AsyncIterable<T> | ReadableStream<T>;
  let opts: PipeStreamOptions | undefined;

  if (typeof keyOrValue === "string") {
    // pipe(key, value, options?)
    key = keyOrValue;
    value = valueOrOptions as AsyncIterable<T> | ReadableStream<T>;
    opts = options;
  } else {
    // pipe(value, options?)
    key = DEFAULT_STREAM_KEY;
    value = keyOrValue;
    opts = valueOrOptions as PipeStreamOptions | undefined;
  }

  return pipeInternal(key, value, opts, "streams.pipe()");
}

/**
 * Internal pipe implementation that allows customizing the span name.
 * This is used by both the public `pipe` method and the `writer` method.
 */
function pipeInternal<T>(
  key: string,
  value: AsyncIterable<T> | ReadableStream<T>,
  opts: PipeStreamOptions | undefined,
  spanName: string
): PipeStreamResult<T> {
  const runId = getRunIdForOptions(opts);

  if (!runId) {
    throw new Error(
      "Could not determine the target run ID for the realtime stream. Please specify a target run ID using the `target` option or use this function from inside a task."
    );
  }

  const span = tracer.startSpan(spanName, {
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
    const instance = realtimeStreams.pipe(key, value, {
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
 * import { streams } from "@trigger.dev/sdk";
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

function append<TPart extends BodyInit>(value: TPart, options?: AppendStreamOptions): Promise<void>;
function append<TPart extends BodyInit>(
  key: string,
  value: TPart,
  options?: AppendStreamOptions
): Promise<void>;
function append<TPart extends BodyInit>(
  keyOrValue: string | TPart,
  valueOrOptions?: TPart | AppendStreamOptions,
  options?: AppendStreamOptions
): Promise<void> {
  if (typeof keyOrValue === "string" && typeof valueOrOptions === "string") {
    return appendInternal(keyOrValue, valueOrOptions, options);
  }

  if (typeof keyOrValue === "string") {
    if (isAppendStreamOptions(valueOrOptions)) {
      return appendInternal(DEFAULT_STREAM_KEY, keyOrValue, valueOrOptions);
    } else {
      if (!valueOrOptions) {
        return appendInternal(DEFAULT_STREAM_KEY, keyOrValue, options);
      }

      return appendInternal(keyOrValue, valueOrOptions, options);
    }
  } else {
    if (isAppendStreamOptions(valueOrOptions)) {
      return appendInternal(DEFAULT_STREAM_KEY, keyOrValue, valueOrOptions);
    } else {
      return appendInternal(DEFAULT_STREAM_KEY, keyOrValue, options);
    }
  }
}

async function appendInternal<TPart extends BodyInit>(
  key: string,
  part: TPart,
  options?: AppendStreamOptions
): Promise<void> {
  const runId = getRunIdForOptions(options);

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

  try {
    await realtimeStreams.append(key, part, options);
    span.end();
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

function isAppendStreamOptions(val: unknown): val is AppendStreamOptions {
  return (
    typeof val === "object" &&
    val !== null &&
    !Array.isArray(val) &&
    (("target" in val && typeof val.target === "string") ||
      ("requestOptions" in val && typeof val.requestOptions === "object"))
  );
}

/**
 * Writes data to a realtime stream using the default stream key (`"default"`).
 *
 * This is a convenience overload that allows you to write to the default stream without
 * specifying a stream key. The stream will be created/accessed with the key `"default"`.
 *
 * @template TPart - The type of data chunks in the stream
 * @param options - The options for writing to the stream
 * @returns A promise that resolves to an object containing:
 *   - `stream`: The original stream (can be consumed in your task)
 *   - `waitUntilComplete`: A function that returns a promise resolving when the stream is fully sent
 *
 * @example
 * ```ts
 * import { streams } from "@trigger.dev/sdk";
 *
 * // Write to the default stream
 * const { waitUntilComplete } = await streams.writer({
 *   execute: ({ write, merge }) => {
 *     write("chunk 1");
 *     write("chunk 2");
 *     write("chunk 3");
 *   },
 * });
 *
 * // Wait for all chunks to be written
 * await waitUntilComplete();
 * ```
 *
 * @example
 * ```ts
 * // Write to a specific stream key
 * const { waitUntilComplete } = await streams.writer("my-custom-stream", {
 *   execute: ({ write, merge }) => {
 *     write("chunk 1");
 *     write("chunk 2");
 *     write("chunk 3");
 *   },
 * });
 *
 * // Wait for all chunks to be written
 * await waitUntilComplete();
 * ```
 *
 * @example
 * ```ts
 * // Write to a parent run
 * await streams.writer("output", {
 *   execute: ({ write, merge }) => {
 *     write("chunk 1");
 *     write("chunk 2");
 *     write("chunk 3");
 *   },
 * });
 *
 * // Wait for all chunks to be written
 * await waitUntilComplete();
 * ```
 *
 * @example
 * ```ts
 * // Write to a specific stream key
 * await streams.writer("my-custom-stream", {
 *   execute: ({ write, merge }) => {
 *     write("chunk 1");
 *     write("chunk 2");
 *     write("chunk 3");
 *   },
 * });
 *
 * // Wait for all chunks to be written
 * await waitUntilComplete();
 * ```
 */
function writer<TPart>(options: WriterStreamOptions<TPart>): PipeStreamResult<TPart>;
/**
 * Writes data to a realtime stream with a specific stream key.
 *
 * @template TPart - The type of data chunks in the stream
 * @param key - The unique identifier of the stream to write to. Defaults to `"default"` if not provided.
 * @param options - The options for writing to the stream
 * @returns A promise that resolves to an object containing:
 *   - `stream`: The original stream (can be consumed in your task)
 *   - `waitUntilComplete`: A function that returns a promise resolving when the stream is fully sent
 *
 * @example
 * ```ts
 * import { streams } from "@trigger.dev/sdk";
 *
 * // Write to a specific stream key
 * const { waitUntilComplete } = await streams.writer("my-custom-stream", {
 *   execute: ({ write, merge }) => {
 *     write("chunk 1");
 *     write("chunk 2");
 *     write("chunk 3");
 *   },
 * });
 *
 * // Wait for all chunks to be written
 * await waitUntilComplete();
 * ```
 */
function writer<TPart>(key: string, options: WriterStreamOptions<TPart>): PipeStreamResult<TPart>;
function writer<TPart>(
  keyOrOptions: string | WriterStreamOptions<TPart>,
  valueOrOptions?: WriterStreamOptions<TPart>
): PipeStreamResult<TPart> {
  if (typeof keyOrOptions === "string") {
    return writerInternal(keyOrOptions, valueOrOptions!);
  }

  return writerInternal(DEFAULT_STREAM_KEY, keyOrOptions);
}

function writerInternal<TPart>(key: string, options: WriterStreamOptions<TPart>) {
  let controller!: ReadableStreamDefaultController<TPart>;

  const ongoingStreamPromises: Promise<void>[] = [];

  const stream = new ReadableStream({
    start(controllerArg) {
      controller = controllerArg;
    },
  });

  function safeEnqueue(data: TPart) {
    try {
      controller.enqueue(data);
    } catch (error) {
      // suppress errors when the stream has been closed
    }
  }

  try {
    const result = options.execute({
      write(part) {
        safeEnqueue(part);
      },
      merge(streamArg) {
        ongoingStreamPromises.push(
          (async () => {
            const reader = streamArg.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              safeEnqueue(value);
            }
          })().catch((error) => {
            console.error(error);
          })
        );
      },
    });

    if (result) {
      ongoingStreamPromises.push(
        result.catch((error) => {
          console.error(error);
        })
      );
    }
  } catch (error) {
    console.error(error);
  }

  const waitForStreams: Promise<void> = new Promise(async (resolve) => {
    while (ongoingStreamPromises.length > 0) {
      await ongoingStreamPromises.shift();
    }
    resolve();
  });

  waitForStreams.finally(() => {
    try {
      controller.close();
    } catch (error) {
      // suppress errors when the stream has been closed
    }
  });

  return pipeInternal(key, stream, options, "streams.writer()");
}

export type RealtimeDefineStreamOptions = {
  id: string;
};

function define<TPart>(opts: RealtimeDefineStreamOptions): RealtimeDefinedStream<TPart> {
  return {
    id: opts.id,
    pipe(value, options) {
      return pipe(opts.id, value, options);
    },
    read(runId, options) {
      return read(runId, opts.id, options);
    },
    append(value, options) {
      return append(opts.id, value as BodyInit, options);
    },
    writer(options) {
      return writer(opts.id, options);
    },
  };
}

export type { InferStreamType };

export const streams = {
  pipe,
  read,
  append,
  writer,
  define,
};

function getRunIdForOptions(options?: RealtimeStreamOperationOptions): string | undefined {
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
