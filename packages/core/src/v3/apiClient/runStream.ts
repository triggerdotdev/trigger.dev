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
import { LineTransformStream, zodShapeStream } from "./stream.js";
import {
  AsyncIterableStream,
  createAsyncIterableReadable,
} from "../streams/asyncIterableStream.js";

export type RunShape<TRunTypes extends AnyRunTypes> = TRunTypes extends AnyRunTypes
  ? {
      id: string;
      taskIdentifier: TRunTypes["taskIdentifier"];
      payload: TRunTypes["payload"];
      output?: TRunTypes["output"];
      createdAt: Date;
      updatedAt: Date;
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
      isQueued: boolean;
      isExecuting: boolean;
      isWaiting: boolean;
      isCompleted: boolean;
      isFailed: boolean;
      isSuccess: boolean;
      isCancelled: boolean;
      realtimeStreams: string[];
    }
  : never;

export type AnyRunShape = RunShape<AnyRunTypes>;

export type TaskRunShape<TTask extends AnyTask> = RunShape<InferRunTypes<TTask>>;
export type RealtimeRun<TTask extends AnyTask> = TaskRunShape<TTask>;
export type AnyRealtimeRun = RealtimeRun<AnyTask>;

export type RealtimeRunSkipColumns = Array<
  | "startedAt"
  | "delayUntil"
  | "queuedAt"
  | "expiredAt"
  | "completedAt"
  | "number"
  | "isTest"
  | "usageDurationMs"
  | "costInCents"
  | "baseCostInCents"
  | "ttl"
  | "payload"
  | "payloadType"
  | "metadata"
  | "output"
  | "outputType"
  | "runTags"
  | "error"
>;

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

export type CreateStreamSubscriptionOptions = {
  baseUrl?: string;
  onComplete?: () => void;
  onError?: (error: Error) => void;
  timeoutInSeconds?: number;
  lastEventId?: string;
};

export interface StreamSubscriptionFactory {
  createSubscription(
    runId: string,
    streamKey: string,
    options?: CreateStreamSubscriptionOptions
  ): StreamSubscription;
}

// Real implementation for production
export class SSEStreamSubscription implements StreamSubscription {
  private lastEventId: string | undefined;
  private retryCount = 0;
  private maxRetries = 5;
  private retryDelayMs = 1000;

  constructor(
    private url: string,
    private options: {
      headers?: Record<string, string>;
      signal?: AbortSignal;
      onComplete?: () => void;
      onError?: (error: Error) => void;
      timeoutInSeconds?: number;
      lastEventId?: string;
    }
  ) {
    this.lastEventId = options.lastEventId;
  }

  async subscribe(): Promise<ReadableStream<unknown>> {
    const self = this;

    return new ReadableStream({
      async start(controller) {
        await self.connectStream(controller);
      },
      cancel(reason) {
        self.options.onComplete?.();
      },
    });
  }

  private async connectStream(controller: ReadableStreamDefaultController): Promise<void> {
    try {
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        ...this.options.headers,
      };

      // Include Last-Event-ID header if we're resuming
      if (this.lastEventId) {
        headers["Last-Event-ID"] = this.lastEventId;
      }

      if (this.options.timeoutInSeconds) {
        headers["Timeout-Seconds"] = this.options.timeoutInSeconds.toString();
      }

      const response = await fetch(this.url, {
        headers,
        signal: this.options.signal,
      });

      if (!response.ok) {
        const error = ApiError.generate(
          response.status,
          {},
          "Could not subscribe to stream",
          Object.fromEntries(response.headers)
        );

        this.options.onError?.(error);
        throw error;
      }

      if (!response.body) {
        const error = new Error("No response body");

        this.options.onError?.(error);
        throw error;
      }

      const streamVersion = response.headers.get("X-Stream-Version") ?? "v1";

      // Reset retry count on successful connection
      this.retryCount = 0;

      const stream = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream())
        .pipeThrough(
          new TransformStream({
            transform: (chunk, chunkController) => {
              if (streamVersion === "v1") {
                // Track the last event ID for resume support
                if (chunk.id) {
                  this.lastEventId = chunk.id;
                }
                chunkController.enqueue(safeParseJSON(chunk.data));
              } else {
                if (chunk.event === "batch") {
                  const data = safeParseJSON(chunk.data) as {
                    records: Array<{ body: string; seq_num: number; timestamp: number }>;
                  };

                  for (const record of data.records) {
                    this.lastEventId = record.seq_num.toString();

                    chunkController.enqueue(safeParseJSON(record.body));
                  }
                }
              }
            },
          })
        );

      const reader = stream.getReader();

      try {
        let chunkCount = 0;
        while (true) {
          const { done, value } = await reader.read();

          if (done) {
            reader.releaseLock();
            controller.close();
            this.options.onComplete?.();
            return;
          }

          if (this.options.signal?.aborted) {
            reader.cancel();
            reader.releaseLock();
            controller.close();
            this.options.onComplete?.();
            return;
          }

          chunkCount++;
          controller.enqueue(value);
        }
      } catch (error) {
        reader.releaseLock();
        throw error;
      }
    } catch (error) {
      if (this.options.signal?.aborted) {
        // Don't retry if aborted
        controller.close();
        this.options.onComplete?.();
        return;
      }

      // Retry on error
      await this.retryConnection(controller, error as Error);
    }
  }

  private async retryConnection(
    controller: ReadableStreamDefaultController,
    error?: Error
  ): Promise<void> {
    if (this.options.signal?.aborted) {
      controller.close();
      this.options.onComplete?.();
      return;
    }

    if (this.retryCount >= this.maxRetries) {
      const finalError = error || new Error("Max retries reached");
      controller.error(finalError);
      this.options.onError?.(finalError);
      return;
    }

    this.retryCount++;
    const delay = this.retryDelayMs * Math.pow(2, this.retryCount - 1);

    // Wait before retrying
    await new Promise((resolve) => setTimeout(resolve, delay));

    if (this.options.signal?.aborted) {
      controller.close();
      this.options.onComplete?.();
      return;
    }

    // Reconnect
    await this.connectStream(controller);
  }
}

export class SSEStreamSubscriptionFactory implements StreamSubscriptionFactory {
  constructor(
    private baseUrl: string,
    private options: {
      headers?: Record<string, string>;
      signal?: AbortSignal;
    }
  ) {}

  createSubscription(
    runId: string,
    streamKey: string,
    options?: CreateStreamSubscriptionOptions
  ): StreamSubscription {
    if (!runId || !streamKey) {
      throw new Error("runId and streamKey are required");
    }

    const url = `${options?.baseUrl ?? this.baseUrl}/realtime/v1/streams/${runId}/${streamKey}`;

    return new SSEStreamSubscription(url, {
      ...this.options,
      ...options,
    });
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

          const streams = getStreamsFromRunShape(run);

          // Check for stream metadata
          if (streams.length > 0) {
            for (const streamKey of streams) {
              if (typeof streamKey !== "string") {
                continue;
              }

              if (!activeStreams.has(streamKey)) {
                activeStreams.add(streamKey);

                const subscription = this.options.streamFactory.createSubscription(
                  run.id,
                  streamKey,
                  {
                    baseUrl: this.options.client?.baseUrl,
                  }
                );

                // Start stream processing in the background
                subscription.subscribe().then((stream) => {
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
                    );
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

    const status = apiStatusFromRunStatus(row.status);

    return {
      id: row.friendlyId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      taskIdentifier: row.taskIdentifier,
      status,
      payload,
      output,
      durationMs: row.usageDurationMs ?? 0,
      costInCents: row.costInCents ?? 0,
      baseCostInCents: row.baseCostInCents ?? 0,
      tags: row.runTags ?? [],
      idempotencyKey: row.idempotencyKey ?? undefined,
      expiredAt: row.expiredAt ?? undefined,
      finishedAt: row.completedAt ?? undefined,
      startedAt: row.startedAt ?? undefined,
      delayedUntil: row.delayUntil ?? undefined,
      queuedAt: row.queuedAt ?? undefined,
      error: row.error ? createJsonErrorObject(row.error) : undefined,
      isTest: row.isTest ?? false,
      metadata,
      realtimeStreams: row.realtimeStreams ?? [],
      ...booleanHelpersFromRunStatus(status),
    } as RunShape<TRunTypes>;
  }
}

const queuedStatuses = ["PENDING_VERSION", "QUEUED", "PENDING", "DELAYED"];
const waitingStatuses = ["WAITING"];
const executingStatuses = ["DEQUEUED", "EXECUTING"];
const failedStatuses = ["FAILED", "CRASHED", "SYSTEM_FAILURE", "EXPIRED", "TIMED_OUT"];
const successfulStatuses = ["COMPLETED"];

function booleanHelpersFromRunStatus(status: RunStatus) {
  return {
    isQueued: queuedStatuses.includes(status),
    isWaiting: waitingStatuses.includes(status),
    isExecuting: executingStatuses.includes(status),
    isCompleted: successfulStatuses.includes(status) || failedStatuses.includes(status),
    isFailed: failedStatuses.includes(status),
    isSuccess: successfulStatuses.includes(status),
    isCancelled: status === "CANCELED",
  };
}

function apiStatusFromRunStatus(status: string): RunStatus {
  switch (status) {
    case "DELAYED": {
      return "DELAYED";
    }
    case "WAITING_FOR_DEPLOY":
    case "PENDING_VERSION": {
      return "PENDING_VERSION";
    }
    case "PENDING": {
      return "QUEUED";
    }
    case "PAUSED":
    case "WAITING_TO_RESUME": {
      return "WAITING";
    }
    case "DEQUEUED": {
      return "DEQUEUED";
    }
    case "RETRYING_AFTER_FAILURE":
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
    case "CRASHED": {
      return "CRASHED";
    }
    case "INTERRUPTED":
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
      return "QUEUED";
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
  // @ts-ignore-error
  ReadableStream.prototype.values ??= function ({ preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      async next(): Promise<IteratorResult<any>> {
        try {
          const result = await reader.read();
          if (result.done) {
            reader.releaseLock();
          }
          return {
            done: result.done,
            value: result.value,
          };
        } catch (e) {
          reader.releaseLock();
          throw e;
        }
      },
      async return(value: any): Promise<IteratorResult<any>> {
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

  // @ts-ignore-error
  ReadableStream.prototype[Symbol.asyncIterator] ??= ReadableStream.prototype.values;
}

function getStreamsFromRunShape(run: AnyRunShape): string[] {
  const metadataStreams =
    run.metadata &&
    "$$streams" in run.metadata &&
    Array.isArray(run.metadata.$$streams) &&
    run.metadata.$$streams.length > 0 &&
    run.metadata.$$streams.every((stream) => typeof stream === "string")
      ? run.metadata.$$streams
      : undefined;

  if (metadataStreams) {
    return metadataStreams;
  }

  return run.realtimeStreams;
}
