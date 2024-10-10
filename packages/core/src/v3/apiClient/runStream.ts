import { DeserializedJson } from "../../schemas/json.js";
import { RunStatus, SubscribeRunRawShape } from "../schemas/api.js";
import { SerializedError } from "../schemas/common.js";
import {
  conditionallyImportAndParsePacket,
  IOPacket,
  parsePacket,
} from "../utils/ioSerialization.js";
import { AsyncIterableStream, createAsyncIterableStream, zodShapeStream } from "./stream.js";

export type RunShape<TPayload = any, TOutput = any> = {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  taskIdentifier: string;
  number: number;
  status: RunStatus;
  durationMs: number;
  costInCents: number;
  baseCostInCents: number;
  payload: TPayload;
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
  output?: TOutput;
  isTest: boolean;
};

export type AnyRunShape = RunShape<any, any>;

export type RunStreamCallback<TPayload = any, TOutput = any> = (
  run: RunShape<TPayload, TOutput>
) => void | Promise<void>;

export function runShapeStream<TPayload = any, TOutput = any>(
  url: string,
  fetchClient: typeof fetch
): RunSubscription<TPayload, TOutput> {
  const subscription = new RunSubscription<TPayload, TOutput>(url, fetchClient);

  return subscription.init();
}

export class RunSubscription<TPayload = any, TOutput = any> {
  private abortController: AbortController;
  private unsubscribeShape: () => void;
  private stream: AsyncIterableStream<RunShape<TPayload, TOutput>>;
  private packetCache = new Map<string, any>();

  constructor(
    private url: string,
    private fetchClient: typeof fetch
  ) {
    this.abortController = new AbortController();
  }

  init(): this {
    const source = new ReadableStream<SubscribeRunRawShape>({
      start: async (controller) => {
        this.unsubscribeShape = await zodShapeStream(
          SubscribeRunRawShape,
          this.url,
          async (shape) => {
            controller.enqueue(shape);
            if (shape.completedAt && !this.abortController.signal.aborted) {
              controller.close();
              this.abortController.abort();
            }
          },
          {
            signal: this.abortController.signal,
            fetchClient: this.fetchClient,
          }
        );
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

    return this;
  }

  unsubscribe(): void {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
    }
    this.unsubscribeShape?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<RunShape<TPayload, TOutput>> {
    return this.stream[Symbol.asyncIterator]();
  }

  getReader(): ReadableStreamDefaultReader<RunShape<TPayload, TOutput>> {
    return this.stream.getReader();
  }

  private async transformRunShape(row: SubscribeRunRawShape): Promise<RunShape> {
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

        const result = await conditionallyImportAndParsePacket(packet);
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
    };
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
      return "UNKNOWN";
    }
  }
}
