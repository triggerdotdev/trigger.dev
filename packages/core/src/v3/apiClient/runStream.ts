import { EventSourceMessage, EventSourceParserStream } from "eventsource-parser/stream";
import { DeserializedJson } from "../../schemas/json.js";
import { createJsonErrorObject } from "../errors.js";
import { RunStatus, SubscribeRunRawShape } from "../schemas/api.js";
import { SerializedError } from "../schemas/common.js";
import {
  AsyncIterableStream,
  createAsyncIterableReadable,
} from "../streams/asyncIterableStream.js";
import { AnyRunTypes, AnyTask, InferRunTypes } from "../types/tasks.js";
import { getEnvVar } from "../utils/getEnv.js";
import {
  conditionallyImportAndParsePacket,
  IOPacket,
  parsePacket,
} from "../utils/ioSerialization.js";
import { calculateNextRetryDelay } from "../utils/retries.js";
import { ApiError } from "./errors.js";
import { ApiClient } from "./index.js";
import { zodShapeStream } from "./stream.js";

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

export type RunStreamCursorStore = {
  /** Returns the last event id seen for a stream key, if any. */
  get(streamKey: string): string | undefined;
  /** Records the latest event id seen for a stream key. */
  set(streamKey: string, lastEventId: string): void;
};

export type RunShapeStreamOptions = {
  headers?: Record<string, string>;
  fetchClient?: typeof fetch;
  closeOnComplete?: boolean;
  signal?: AbortSignal;
  client?: ApiClient;
  onFetchError?: (e: Error) => void;
  /**
   * Optional cursor store used to resume per-stream subscriptions across
   * reconnects. When provided, each per-stream SSE subscription seeds its
   * `Last-Event-ID` from `get(streamKey)` and persists incoming event ids via
   * `set(streamKey, id)` — so a tab returning from background or a network
   * blip resumes from where the stream left off instead of replaying from
   * the beginning.
   */
  streamCursors?: RunStreamCursorStore;
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
  subscribe(): Promise<ReadableStream<SSEStreamPart<unknown>>>;
}

export type CreateStreamSubscriptionOptions = {
  baseUrl?: string;
  onComplete?: () => void;
  onError?: (error: Error) => void;
  timeoutInSeconds?: number;
  lastEventId?: string;
  /** Fired whenever the underlying SSE cursor advances. Use this to persist
   * the cursor across reconnects.
   */
  onLastEventId?: (lastEventId: string) => void;
};

export interface StreamSubscriptionFactory {
  createSubscription(
    runId: string,
    streamKey: string,
    options?: CreateStreamSubscriptionOptions
  ): StreamSubscription;
}

export type SSEStreamPart<TChunk = unknown> = {
  id: string;
  chunk: TChunk;
  timestamp: number;
};

// Reconnection tuned for flaky / mobile networks: sub-second first retry with
// jitter, exponential growth, capped at 30s, no attempt cap. Connections drop
// constantly when devices background or transit between cells; the previous
// 5-attempt cap meant a brief outage permanently killed the subscription.
const SSE_RETRY_OPTIONS = {
  maxAttempts: Number.POSITIVE_INFINITY,
  factor: 2,
  minTimeoutInMs: 250,
  maxTimeoutInMs: 30_000,
  randomize: true,
} as const;

// Real implementation for production
export class SSEStreamSubscription implements StreamSubscription {
  private lastEventId: string | undefined;
  private retryCount = 0;

  constructor(
    private url: string,
    private options: {
      headers?: Record<string, string>;
      signal?: AbortSignal;
      onComplete?: () => void;
      onError?: (error: Error) => void;
      timeoutInSeconds?: number;
      lastEventId?: string;
      onLastEventId?: (lastEventId: string) => void;
    }
  ) {
    this.lastEventId = options.lastEventId;
  }

  async subscribe(): Promise<ReadableStream<SSEStreamPart>> {
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

  private async connectStream(
    controller: ReadableStreamDefaultController<SSEStreamPart>
  ): Promise<void> {
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

        // Only surface terminal errors. Retryable HTTP statuses (5xx, 408, 429)
        // are handled by retryConnection without firing onError on each attempt.
        if (!isRetryableStreamError(error)) {
          this.options.onError?.(error);
        }
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

      const seenIds = new Set<string>();

      const stream = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream())
        .pipeThrough(
          new TransformStream<EventSourceMessage, SSEStreamPart>({
            transform: (chunk, chunkController) => {
              if (streamVersion === "v1") {
                // Track the last event ID for resume support
                if (chunk.id) {
                  this.lastEventId = chunk.id;
                  this.options.onLastEventId?.(chunk.id);
                }

                const timestamp = parseRedisStreamIdTimestamp(chunk.id);

                chunkController.enqueue({
                  id: chunk.id ?? "unknown",
                  chunk: safeParseJSON(chunk.data),
                  timestamp,
                });
              } else {
                if (chunk.event === "batch") {
                  const data = safeParseJSON(chunk.data) as {
                    records: Array<{ body: string; seq_num: number; timestamp: number }>;
                  };

                  for (const record of data.records) {
                    const eventId = record.seq_num.toString();
                    this.lastEventId = eventId;
                    this.options.onLastEventId?.(eventId);

                    const parsedBody = safeParseJSON(record.body) as { data: unknown; id: string };
                    if (seenIds.has(parsedBody.id)) {
                      continue;
                    }
                    seenIds.add(parsedBody.id);

                    chunkController.enqueue({
                      id: eventId,
                      chunk: parsedBody.data,
                      timestamp: record.timestamp,
                    });
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

    if (!isRetryableStreamError(error)) {
      const finalError = error ?? new Error("Stream subscription failed");
      controller.error(finalError);
      this.options.onError?.(finalError);
      return;
    }

    this.retryCount++;
    const delay =
      calculateNextRetryDelay(SSE_RETRY_OPTIONS, this.retryCount) ??
      SSE_RETRY_OPTIONS.maxTimeoutInMs;

    await new Promise((resolve) => setTimeout(resolve, delay));

    if (this.options.signal?.aborted) {
      controller.close();
      this.options.onComplete?.();
      return;
    }

    await this.connectStream(controller);
  }
}

// 4xx (other than 408 timeout / 429 rate limit) means the request is
// fundamentally bad — auth, not found, etc. Retrying just burns cycles.
// Everything else (network errors with no status, 5xx, transient timeouts)
// retries forever with backoff.
function isRetryableStreamError(error?: Error): boolean {
  if (!(error instanceof ApiError)) return true;
  if (typeof error.status !== "number") return true;
  if (error.status >= 400 && error.status < 500) {
    return error.status === 408 || error.status === 429;
  }
  return true;
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

                const cursors = this.options.streamCursors;
                const subscription = this.options.streamFactory.createSubscription(
                  run.id,
                  streamKey,
                  {
                    baseUrl: this.options.client?.baseUrl,
                    lastEventId: cursors?.get(streamKey),
                    onLastEventId: cursors
                      ? (id) => cursors.set(streamKey, id)
                      : undefined,
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
                            chunk: chunk.chunk as TStreams[typeof streamKey],
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

// Redis stream IDs are in the format: <timestamp>-<sequence>
function parseRedisStreamIdTimestamp(id?: string): number {
  if (!id) {
    return Date.now();
  }

  const timestamp = parseInt(id.split("-")[0] as string, 10);
  if (isNaN(timestamp)) {
    return Date.now();
  }

  return timestamp;
}
