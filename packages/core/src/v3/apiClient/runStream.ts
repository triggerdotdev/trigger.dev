import { EventSourceParserStream } from "eventsource-parser/stream";
import { DeserializedJson } from "../../schemas/json.js";
import { createJsonErrorObject } from "../errors.js";
import {
  RunStatus,
  SubscribeRealtimeStreamChunkRawShape,
  SubscribeRunRawShape,
} from "../schemas/api.js";
import { SerializedError } from "../schemas/common.js";
import { AnyRunTypes, AnyTask, InferRunTypes } from "../types/tasks.js";
import { getEnvVar } from "../utils/getEnv.js";
import {
  conditionallyImportAndParsePacket,
  IOPacket,
  parsePacket,
} from "../utils/ioSerialization.js";
import { ApiError } from "./errors.js";
import { ApiClient } from "./index.js";
import {
  AsyncIterableStream,
  createAsyncIterableReadable,
  LineTransformStream,
  zodShapeStream,
} from "./stream.js";

export type RunShape<TRunTypes extends AnyRunTypes> = TRunTypes extends AnyRunTypes
  ? {
      id: string;
      taskIdentifier: TRunTypes["taskIdentifier"];
      payload: TRunTypes["payload"];
      output?: TRunTypes["output"];
      createdAt: Date;
      updatedAt: Date;
      number: number;
      status: RunStatus;
      durationMs: number;
      costInCents: number;
      baseCostInCents: number;
      tags: string[];
      idempotencyKey?: string;
      expiredAt?: Date;
      ttl?: string;
      finishedAt?: Date;
      startedAt?: Date;
      delayedUntil?: Date;
      queuedAt?: Date;
      metadata?: Record<string, DeserializedJson>;
      error?: SerializedError;
      isTest: boolean;
    }
  : never;

export type AnyRunShape = RunShape<AnyRunTypes>;

export type TaskRunShape<TTask extends AnyTask> = RunShape<InferRunTypes<TTask>>;
export type RealtimeRun<TTask extends AnyTask> = TaskRunShape<TTask>;
export type AnyRealtimeRun = RealtimeRun<AnyTask>;

export type RunStreamCallback<TRunTypes extends AnyRunTypes> = (
  run: RunShape<TRunTypes>
) => void | Promise<void>;

export type RunShapeStreamOptions = {
  headers?: Record<string, string>;
  fetchClient?: typeof fetch;
  closeOnComplete?: boolean;
  signal?: AbortSignal;
  client?: ApiClient;
  onFetchError?: (e: Error) => void;
};

export type StreamPartResult<TRun, TStreams extends Record<string, any>> = {
  [K in keyof TStreams]: {
    type: K;
    chunk: TStreams[K];
    run: TRun;
  };
}[keyof TStreams];

export type RunWithStreamsResult<TRun, TStreams extends Record<string, any>> =
  | {
      type: "run";
      run: TRun;
    }
  | StreamPartResult<TRun, TStreams>;

export function runShapeStream<TRunTypes extends AnyRunTypes>(
  url: string,
  options?: RunShapeStreamOptions
): RunSubscription<TRunTypes> {
  const abortController = new AbortController();

  const streamFactory = new SSEStreamSubscriptionFactory(
    getEnvVar("TRIGGER_STREAM_URL", getEnvVar("TRIGGER_API_URL")) ?? "https://api.trigger.dev",
    {
      headers: options?.headers,
      signal: abortController.signal,
    }
  );

  // If the user supplied AbortSignal is aborted, we should abort the internal controller
  options?.signal?.addEventListener(
    "abort",
    () => {
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    },
    { once: true }
  );

  const runStreamInstance = zodShapeStream(SubscribeRunRawShape, url, {
    ...options,
    signal: abortController.signal,
    onError: (e) => {
      options?.onFetchError?.(e);
    },
  });

  const $options: RunSubscriptionOptions = {
    runShapeStream: runStreamInstance.stream,
    stopRunShapeStream: () => runStreamInstance.stop(30 * 1000),
    streamFactory: streamFactory,
    abortController,
    ...options,
  };

  return new RunSubscription<TRunTypes>($options);
}

// First, define interfaces for the stream handling
export interface StreamSubscription {
  subscribe(): Promise<ReadableStream<unknown>>;
}

export interface StreamSubscriptionFactory {
  createSubscription(runId: string, streamKey: string, baseUrl?: string): StreamSubscription;
}

// Real implementation for production
export class SSEStreamSubscription implements StreamSubscription {
  constructor(
    private url: string,
    private options: { headers?: Record<string, string>; signal?: AbortSignal }
  ) {}

  async subscribe(): Promise<ReadableStream<unknown>> {
    return fetch(this.url, {
      headers: {
        Accept: "text/event-stream",
        ...this.options.headers,
      },
      signal: this.options.signal,
    }).then((response) => {
      if (!response.ok) {
        throw ApiError.generate(
          response.status,
          {},
          "Could not subscribe to stream",
          Object.fromEntries(response.headers)
        );
      }

      if (!response.body) {
        throw new Error("No response body");
      }

      return response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream())
        .pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              controller.enqueue(safeParseJSON(chunk.data));
            },
          })
        );
    });
  }
}

export class SSEStreamSubscriptionFactory implements StreamSubscriptionFactory {
  constructor(
    private baseUrl: string,
    private options: { headers?: Record<string, string>; signal?: AbortSignal }
  ) {}

  createSubscription(runId: string, streamKey: string, baseUrl?: string): StreamSubscription {
    if (!runId || !streamKey) {
      throw new Error("runId and streamKey are required");
    }

    const url = `${baseUrl ?? this.baseUrl}/realtime/v1/streams/${runId}/${streamKey}`;
    return new SSEStreamSubscription(url, this.options);
  }
}

// Real implementation for production
export class ElectricStreamSubscription implements StreamSubscription {
  constructor(
    private url: string,
    private options: { headers?: Record<string, string>; signal?: AbortSignal }
  ) {}

  async subscribe(): Promise<ReadableStream<unknown>> {
    return zodShapeStream(SubscribeRealtimeStreamChunkRawShape, this.url, this.options)
      .stream.pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            controller.enqueue(chunk.value);
          },
        })
      )
      .pipeThrough(new LineTransformStream())
      .pipeThrough(
        new TransformStream({
          transform(chunk, controller) {
            for (const line of chunk) {
              controller.enqueue(safeParseJSON(line));
            }
          },
        })
      );
  }
}

export interface RunShapeProvider {
  onShape(callback: (shape: SubscribeRunRawShape) => Promise<void>): Promise<() => void>;
}

export type RunSubscriptionOptions = RunShapeStreamOptions & {
  runShapeStream: ReadableStream<SubscribeRunRawShape>;
  stopRunShapeStream: () => void;
  streamFactory: StreamSubscriptionFactory;
  abortController: AbortController;
};

export class RunSubscription<TRunTypes extends AnyRunTypes> {
  private stream: AsyncIterableStream<RunShape<TRunTypes>>;
  private packetCache = new Map<string, any>();
  private _closeOnComplete: boolean;
  private _isRunComplete = false;

  constructor(private options: RunSubscriptionOptions) {
    this._closeOnComplete =
      typeof options.closeOnComplete === "undefined" ? true : options.closeOnComplete;

    this.stream = createAsyncIterableReadable(
      this.options.runShapeStream,
      {
        transform: async (chunk, controller) => {
          const run = await this.transformRunShape(chunk);

          controller.enqueue(run);

          // only set the run to complete when finishedAt is set
          this._isRunComplete = !!run.finishedAt;

          if (
            this._closeOnComplete &&
            this._isRunComplete &&
            !this.options.abortController.signal.aborted
          ) {
            this.options.stopRunShapeStream();
          }
        },
      },
      this.options.abortController.signal
    );
  }

  unsubscribe(): void {
    if (!this.options.abortController.signal.aborted) {
      this.options.abortController.abort();
    }
    this.options.stopRunShapeStream();
  }

  [Symbol.asyncIterator](): AsyncIterator<RunShape<TRunTypes>> {
    return this.stream[Symbol.asyncIterator]();
  }

  getReader(): ReadableStreamDefaultReader<RunShape<TRunTypes>> {
    return this.stream.getReader();
  }

  withStreams<TStreams extends Record<string, any>>(): AsyncIterableStream<
    RunWithStreamsResult<RunShape<TRunTypes>, TStreams>
  > {
    // Keep track of which streams we've already subscribed to
    const activeStreams = new Set<string>();

    return createAsyncIterableReadable(
      this.stream,
      {
        transform: async (run, controller) => {
          controller.enqueue({
            type: "run",
            run,
          });

          // Check for stream metadata
          if (
            run.metadata &&
            "$$streams" in run.metadata &&
            Array.isArray(run.metadata.$$streams)
          ) {
            for (const streamKey of run.metadata.$$streams) {
              if (typeof streamKey !== "string") {
                continue;
              }

              if (!activeStreams.has(streamKey)) {
                activeStreams.add(streamKey);

                const subscription = this.options.streamFactory.createSubscription(
                  run.id,
                  streamKey,
                  this.options.client?.baseUrl
                );

                // Start stream processing in the background
                subscription
                  .subscribe()
                  .then((stream) => {
                    stream
                      .pipeThrough(
                        new TransformStream({
                          transform(chunk, controller) {
                            controller.enqueue({
                              type: streamKey,
                              chunk: chunk as TStreams[typeof streamKey],
                              run,
                            });
                          },
                        })
                      )
                      .pipeTo(
                        new WritableStream({
                          write(chunk) {
                            controller.enqueue(chunk);
                          },
                        })
                      )
                      .catch((error) => {
                        console.error(`Error in stream ${streamKey}:`, error);
                      });
                  })
                  .catch((error) => {
                    console.error(`Error subscribing to stream ${streamKey}:`, error);
                  });
              }
            }
          }
        },
      },
      this.options.abortController.signal
    );
  }

  private async transformRunShape(row: SubscribeRunRawShape): Promise<RunShape<TRunTypes>> {
    const payloadPacket = row.payloadType
      ? ({ data: row.payload ?? undefined, dataType: row.payloadType } satisfies IOPacket)
      : undefined;

    const outputPacket = row.outputType
      ? ({ data: row.output ?? undefined, dataType: row.outputType } satisfies IOPacket)
      : undefined;

    const [payload, output] = await Promise.all(
      [
        { packet: payloadPacket, key: "payload" },
        { packet: outputPacket, key: "output" },
      ].map(async ({ packet, key }) => {
        if (!packet) {
          return;
        }

        const cachedResult = this.packetCache.get(`${row.friendlyId}/${key}`);

        if (typeof cachedResult !== "undefined") {
          return cachedResult;
        }

        const result = await conditionallyImportAndParsePacket(packet, this.options.client);
        this.packetCache.set(`${row.friendlyId}/${key}`, result);

        return result;
      })
    );

    const metadata =
      row.metadata && row.metadataType
        ? await parsePacket({ data: row.metadata, dataType: row.metadataType })
        : undefined;

    return {
      id: row.friendlyId,
      payload,
      output,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      taskIdentifier: row.taskIdentifier,
      number: row.number,
      status: apiStatusFromRunStatus(row.status),
      durationMs: row.usageDurationMs,
      costInCents: row.costInCents,
      baseCostInCents: row.baseCostInCents,
      tags: row.runTags ?? [],
      idempotencyKey: row.idempotencyKey ?? undefined,
      expiredAt: row.expiredAt ?? undefined,
      finishedAt: row.completedAt ?? undefined,
      startedAt: row.startedAt ?? undefined,
      delayedUntil: row.delayUntil ?? undefined,
      queuedAt: row.queuedAt ?? undefined,
      error: row.error ? createJsonErrorObject(row.error) : undefined,
      isTest: row.isTest,
      metadata,
    } as RunShape<TRunTypes>;
  }
}

function apiStatusFromRunStatus(status: string): RunStatus {
  switch (status) {
    case "DELAYED": {
      return "DELAYED";
    }
    case "WAITING_FOR_DEPLOY": {
      return "WAITING_FOR_DEPLOY";
    }
    case "PENDING": {
      return "QUEUED";
    }
    case "PAUSED":
    case "WAITING_TO_RESUME": {
      return "FROZEN";
    }
    case "RETRYING_AFTER_FAILURE": {
      return "REATTEMPTING";
    }
    case "EXECUTING": {
      return "EXECUTING";
    }
    case "CANCELED": {
      return "CANCELED";
    }
    case "COMPLETED_SUCCESSFULLY": {
      return "COMPLETED";
    }
    case "SYSTEM_FAILURE": {
      return "SYSTEM_FAILURE";
    }
    case "INTERRUPTED": {
      return "INTERRUPTED";
    }
    case "CRASHED": {
      return "CRASHED";
    }
    case "COMPLETED_WITH_ERRORS": {
      return "FAILED";
    }
    case "EXPIRED": {
      return "EXPIRED";
    }
    case "TIMED_OUT": {
      return "TIMED_OUT";
    }
    default: {
      throw new Error(`Unknown status: ${status}`);
    }
  }
}

function safeParseJSON(data: string): unknown {
  try {
    return JSON.parse(data);
  } catch (error) {
    return data;
  }
}

const isSafari = () => {
  // Check if we're in a browser environment
  if (
    typeof window !== "undefined" &&
    typeof navigator !== "undefined" &&
    typeof navigator.userAgent === "string"
  ) {
    return (
      /^((?!chrome|android).)*safari/i.test(navigator.userAgent) ||
      /iPad|iPhone|iPod/.test(navigator.userAgent)
    );
  }
  // If we're not in a browser environment, return false
  return false;
};

/**
 * A polyfill for `ReadableStream.protototype[Symbol.asyncIterator]`,
 * aligning as closely as possible to the specification.
 *
 * @see https://streams.spec.whatwg.org/#rs-asynciterator
 * @see https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream#async_iteration
 *
 * This is needed for Safari: https://bugs.webkit.org/show_bug.cgi?id=194379
 *
 * From https://gist.github.com/MattiasBuelens/496fc1d37adb50a733edd43853f2f60e
 *
 */

if (isSafari()) {
  // @ts-expect-error
  ReadableStream.prototype.values ??= function ({ preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      async next() {
        try {
          const result = await reader.read();
          if (result.done) {
            reader.releaseLock();
          }
          return result;
        } catch (e) {
          reader.releaseLock();
          throw e;
        }
      },
      async return(value: unknown) {
        if (!preventCancel) {
          const cancelPromise = reader.cancel(value);
          reader.releaseLock();
          await cancelPromise;
        } else {
          reader.releaseLock();
        }
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };

  // @ts-expect-error
  ReadableStream.prototype[Symbol.asyncIterator] ??= ReadableStream.prototype.values;
}
