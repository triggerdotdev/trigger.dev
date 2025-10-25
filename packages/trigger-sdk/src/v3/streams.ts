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

export type AppendStreamOptions = {
  signal?: AbortSignal;
  target?: string;
  requestOptions?: ApiRequestOptions;
};

export type AppendStreamResult<T> = {
  stream: AsyncIterableStream<T>;
  waitUntilComplete: () => Promise<void>;
};

async function append<T>(
  key: string,
  value: AsyncIterable<T> | ReadableStream<T>,
  options?: AppendStreamOptions
): Promise<AppendStreamResult<T>> {
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

  const requestOptions = mergeRequestOptions({}, options?.requestOptions);

  try {
    const instance = await realtimeStreams.append(key, value, {
      signal: options?.signal,
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

export type ReadStreamOptions = {
  signal?: AbortSignal;
  /**
   * The number of seconds to wait for new data to be available,
   * If no data arrives within the timeout, the stream will be closed.
   *
   * @default 60 seconds
   */
  timeoutInSeconds?: number;

  /**
   * The index to start reading from.
   * If not provided, the stream will start from the beginning.
   * @default 0
   */
  startIndex?: number;
};

async function readStream<T>(
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
  read: readStream,
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
