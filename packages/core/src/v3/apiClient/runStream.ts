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
import { ApiError, isTriggerRealtimeAuthError } from "./errors.js";
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
  subscribe(): Promise<ReadableStream<SSEStreamPart<unknown>>>;
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

export type SSEStreamPart<TChunk = unknown> = {
  id: string;
  chunk: TChunk;
  timestamp: number;
};

// Real implementation for production
export class SSEStreamSubscription implements StreamSubscription {
  private lastEventId: string | undefined;
  private retryCount = 0;
  private maxRetries: number;
  private retryDelayMs: number;
  private maxRetryDelayMs: number;
  private retryJitter: number;
  private fetchTimeoutMs: number;
  private stallTimeoutMs: number;
  private nonRetryableStatuses: ReadonlySet<number>;
  private retryNowController: AbortController | null = null;
  private internalAbort: AbortController | null = null;

  constructor(
    private url: string,
    private options: {
      headers?: Record<string, string>;
      signal?: AbortSignal;
      onComplete?: () => void;
      onError?: (error: Error) => void;
      timeoutInSeconds?: number;
      lastEventId?: string;
      // Retry knobs. Defaults: retry forever, 100ms initial backoff,
      // capped at 5s with 50% jitter. Keeps mobile clients reconnecting
      // through transient drops without giving up after a fixed window
      // and prevents thundering-herd when many clients reconnect after
      // a brief server blip.
      maxRetries?: number;
      retryDelayMs?: number;
      maxRetryDelayMs?: number;
      retryJitter?: number;
      // Per-attempt fetch timeout — aborts the connect attempt if
      // response headers don't arrive in time. Catches stuck TCP
      // sockets where `fetch()` blocks forever waiting on a dead
      // server. Cleared once headers arrive; long-lived chunk reads
      // are governed by `stallTimeoutMs` instead.
      fetchTimeoutMs?: number;
      // Stall detector — if no chunks arrive within this window after
      // the connection is established, force a reconnect. Catches
      // silent-dead-socket cases (mobile OS killed the TCP socket but
      // the read just blocks). Disabled (`0`) by default; opt in
      // explicitly. Servers that emit periodic keepalive comments
      // reset the timer naturally.
      stallTimeoutMs?: number;
      // HTTP statuses that should NOT be retried — fail the stream
      // permanently. `404` (stream gone) and `410` (session closed)
      // are sensible defaults; tune per-caller for other 4xx.
      nonRetryableStatuses?: readonly number[];
    }
  ) {
    this.lastEventId = options.lastEventId;
    this.maxRetries = options.maxRetries ?? Infinity;
    this.retryDelayMs = options.retryDelayMs ?? 100;
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 5000;
    this.retryJitter = options.retryJitter ?? 0.5;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 30_000;
    this.stallTimeoutMs = options.stallTimeoutMs ?? 0;
    this.nonRetryableStatuses = new Set(options.nonRetryableStatuses ?? [404, 410]);
  }

  /**
   * Wake an in-flight retry backoff and reconnect immediately.
   *
   * No-op if no retry is currently waiting (i.e. we're already
   * connected and reading). Use this for cheap "hint" wakeups like
   * the `online` event or a short-hidden visibility return —
   * `forceReconnect()` is the heavier hammer.
   */
  retryNow(): void {
    this.retryNowController?.abort();
  }

  /**
   * Drop the current connection (or wake a pending backoff) and
   * reconnect.
   *
   * Use when the existing TCP socket is suspected dead but the reader
   * hasn't noticed yet — common after a mobile tab background-kill or
   * a Safari bfcache restore. Aborts the in-flight fetch / read so
   * the catch path takes us through `retryConnection` and re-fetches
   * with `Last-Event-ID`.
   */
  forceReconnect(): void {
    this.internalAbort?.abort();
    this.retryNowController?.abort();
  }

  async subscribe(): Promise<ReadableStream<SSEStreamPart>> {
    const self = this;

    return new ReadableStream({
      async start(controller) {
        await self.connectStream(controller);
      },
      cancel() {
        self.options.onComplete?.();
      },
    });
  }

  private async connectStream(
    controller: ReadableStreamDefaultController<SSEStreamPart>
  ): Promise<void> {
    // Two abort sources flow through `internalAbort.signal`:
    //   - this.options.signal: caller cancel — bypass retry, exit cleanly.
    //   - this.internalAbort: per-attempt force-reconnect / fetch-timeout
    //     / stall-timeout — treated as a transient error, retry path runs.
    // Use `this.options.signal?.aborted` in the catch to distinguish.
    this.internalAbort = new AbortController();
    const unlinkUserAbort = linkAbort(this.options.signal, this.internalAbort);

    // Per-attempt fetch timeout. Cleared once response headers arrive;
    // chunk-read latency is governed by `stallTimeoutMs` instead.
    const fetchTimer = setTimeout(() => this.internalAbort?.abort(), this.fetchTimeoutMs);

    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      if (this.stallTimeoutMs <= 0) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => this.internalAbort?.abort(), this.stallTimeoutMs);
    };

    // Idempotent — both the catch (before recursion) and the finally
    // call this. Without the catch-side call, every retry leaks an
    // abort listener on `this.options.signal` because the finally
    // doesn't run until the entire recursion unwinds.
    const cleanupAttempt = () => {
      clearTimeout(fetchTimer);
      clearTimeout(stallTimer);
      unlinkUserAbort();
      this.internalAbort = null;
    };

    try {
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
        ...this.options.headers,
      };
      if (this.lastEventId) headers["Last-Event-ID"] = this.lastEventId;
      if (this.options.timeoutInSeconds) {
        headers["Timeout-Seconds"] = this.options.timeoutInSeconds.toString();
      }

      const response = await fetch(this.url, {
        headers,
        signal: this.internalAbort.signal,
      });
      clearTimeout(fetchTimer);

      if (!response.ok) {
        const error = ApiError.generate(
          response.status,
          {},
          "Could not subscribe to stream",
          Object.fromEntries(response.headers)
        );
        this.options.onError?.(error);
        if (this.nonRetryableStatuses.has(response.status)) {
          controller.error(error);
          return;
        }
        throw error;
      }

      if (!response.body) {
        const error = new Error("No response body");
        this.options.onError?.(error);
        throw error;
      }

      const streamVersion = response.headers.get("X-Stream-Version") ?? "v1";
      this.retryCount = 0; // reset on success
      armStall();

      const seenIds = new Set<string>();

      const stream = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream())
        .pipeThrough(
          new TransformStream<EventSourceMessage, SSEStreamPart>({
            transform: (chunk, chunkController) => {
              if (streamVersion === "v1") {
                if (chunk.id) {
                  this.lastEventId = chunk.id;
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
                    this.lastEventId = record.seq_num.toString();
                    const parsedBody = safeParseJSON(record.body) as { data: unknown; id: string };
                    if (seenIds.has(parsedBody.id)) continue;
                    seenIds.add(parsedBody.id);
                    chunkController.enqueue({
                      id: record.seq_num.toString(),
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

          armStall(); // any chunk (including server keepalives) resets the silence timer
          controller.enqueue(value);
        }
      } catch (error) {
        reader.releaseLock();
        throw error;
      }
    } catch (error) {
      if (this.options.signal?.aborted) {
        // User cancel — exit cleanly, don't retry.
        controller.close();
        this.options.onComplete?.();
        return;
      }

      if (isTriggerRealtimeAuthError(error)) {
        this.options.onError?.(error as Error);
        controller.error(error as Error);
        return;
      }

      cleanupAttempt();
      await this.retryConnection(controller, error as Error);
    } finally {
      cleanupAttempt();
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
    const baseDelay = Math.min(
      this.retryDelayMs * Math.pow(2, this.retryCount - 1),
      this.maxRetryDelayMs
    );
    // Jitter scales the delay into [(1 - retryJitter) * base, base].
    // E.g. retryJitter=0.5 → final delay is in [50%, 100%] of base.
    // Spreads simultaneous reconnect attempts so many clients don't
    // dogpile on the server right after a brief outage.
    const delay = baseDelay * (1 - this.retryJitter * Math.random());

    // Wait before retrying. The wait is wakeable: `retryNow()` aborts
    // `retryNowController` so the timer resolves immediately and the
    // next connect attempt starts now (e.g. on tab focus / `online`
    // event from the browser layer).
    this.retryNowController = new AbortController();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.retryNowController?.signal.removeEventListener("abort", onAbort);
        resolve();
      }, delay);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      this.retryNowController!.signal.addEventListener("abort", onAbort, { once: true });
    });
    this.retryNowController = null;

    if (this.options.signal?.aborted) {
      controller.close();
      this.options.onComplete?.();
      return;
    }

    // Reconnect
    await this.connectStream(controller);
  }
}

/**
 * One-way abort link: when `parent` aborts, abort `child` too. Returns
 * a cleanup that removes the listener so `parent` doesn't accumulate
 * subscriptions across many connect attempts.
 */
function linkAbort(parent: AbortSignal | undefined, child: AbortController): () => void {
  if (!parent) return () => {};
  if (parent.aborted) {
    child.abort();
    return () => {};
  }
  const onAbort = () => child.abort();
  parent.addEventListener("abort", onAbort, { once: true });
  return () => parent.removeEventListener("abort", onAbort);
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
