import { DeserializedJson } from "../../schemas/json.js";
import { RunStatus, SubscribeRunRawShape } from "../schemas/api.js";
import { SerializedError } from "../schemas/common.js";
import { AnyRunTypes, AnyTask, InferRunTypes } from "../types/tasks.js";
import { getEnvVar } from "../utils/getEnv.js";
import {
  conditionallyImportAndParsePacket,
  IOPacket,
  parsePacket,
} from "../utils/ioSerialization.js";
import { ApiClient } from "./index.js";
import { AsyncIterableStream, createAsyncIterableStream, zodShapeStream } from "./stream.js";
import { EventSourceParserStream } from "eventsource-parser/stream";

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
  const $options: RunSubscriptionOptions = {
    provider: {
      async onShape(callback) {
        return zodShapeStream(SubscribeRunRawShape, url, callback, options);
      },
    },
    streamFactory: new SSEStreamSubscriptionFactory(
      getEnvVar("TRIGGER_STREAM_URL", getEnvVar("TRIGGER_API_URL")) ?? "https://api.trigger.dev",
      {
        headers: options?.headers,
        signal: options?.signal,
      }
    ),
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

export interface RunShapeProvider {
  onShape(callback: (shape: SubscribeRunRawShape) => Promise<void>): Promise<() => void>;
}

export type RunSubscriptionOptions = RunShapeStreamOptions & {
  provider: RunShapeProvider;
  streamFactory: StreamSubscriptionFactory;
};

export class RunSubscription<TRunTypes extends AnyRunTypes> {
  private abortController: AbortController;
  private unsubscribeShape?: () => void;
  private stream: AsyncIterableStream<RunShape<TRunTypes>>;
  private packetCache = new Map<string, any>();
  private _closeOnComplete: boolean;
  private _isRunComplete = false;

  constructor(private options: RunSubscriptionOptions) {
    this.abortController = new AbortController();
    this._closeOnComplete =
      typeof options.closeOnComplete === "undefined" ? true : options.closeOnComplete;

    const source = new ReadableStream<SubscribeRunRawShape>({
      start: async (controller) => {
        this.unsubscribeShape = await this.options.provider.onShape(async (shape) => {
          controller.enqueue(shape);

          this._isRunComplete = !!shape.completedAt;

          if (
            this._closeOnComplete &&
            this._isRunComplete &&
            !this.abortController.signal.aborted
          ) {
            controller.close();
            this.abortController.abort();
          }
        });
      },
      cancel: () => {
        this.unsubscribe();
      },
    });

    this.stream = createAsyncIterableStream(source, {
      transform: async (chunk, controller) => {
        const run = await this.transformRunShape(chunk);

        controller.enqueue(run);
      },
    });
  }

  unsubscribe(): void {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
    }
    this.unsubscribeShape?.();
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

    return createAsyncIterableStream(this.stream, {
      transform: async (run, controller) => {
        controller.enqueue({
          type: "run",
          run,
        });

        // Check for stream metadata
        if (run.metadata && "$$streams" in run.metadata && Array.isArray(run.metadata.$$streams)) {
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

              const stream = await subscription.subscribe();

              // Create the pipeline and start it
              stream
                .pipeThrough(
                  new TransformStream({
                    transform(chunk, controller) {
                      controller.enqueue({
                        type: streamKey,
                        chunk: chunk as TStreams[typeof streamKey],
                        run,
                      } as StreamPartResult<RunShape<TRunTypes>, TStreams>);
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
            }
          }
        }
      },
    });
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
      error: row.error ?? undefined,
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
