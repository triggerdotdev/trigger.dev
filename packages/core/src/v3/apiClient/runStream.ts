import { DeserializedJson } from "../../schemas/json.js";
import { RunStatus, SubscribeRunRawShape } from "../schemas/api.js";
import { SerializedError } from "../schemas/common.js";
import { AnyRunTypes, AnyTask, InferRunTypes } from "../types/tasks.js";
import {
  conditionallyImportAndParsePacket,
  IOPacket,
  parsePacket,
} from "../utils/ioSerialization.js";
import { AsyncIterableStream, createAsyncIterableStream, zodShapeStream } from "./stream.js";

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

export type RunStreamCallback<TRunTypes extends AnyRunTypes> = (
  run: RunShape<TRunTypes>
) => void | Promise<void>;

export type RunShapeStreamOptions = {
  headers?: Record<string, string>;
  fetchClient?: typeof fetch;
  closeOnComplete?: boolean;
};

export function runShapeStream<TRunTypes extends AnyRunTypes>(
  url: string,
  options?: RunShapeStreamOptions
): RunSubscription<TRunTypes> {
  const subscription = new RunSubscription<TRunTypes>(url, options);

  return subscription.init();
}

export class RunSubscription<TRunTypes extends AnyRunTypes> {
  private abortController: AbortController;
  private unsubscribeShape: () => void;
  private stream: AsyncIterableStream<RunShape<TRunTypes>>;
  private packetCache = new Map<string, any>();

  constructor(
    private url: string,
    private options?: RunShapeStreamOptions
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
            if (
              this.options?.closeOnComplete &&
              shape.completedAt &&
              !this.abortController.signal.aborted
            ) {
              controller.close();
              this.abortController.abort();
            }
          },
          {
            signal: this.abortController.signal,
            fetchClient: this.options?.fetchClient,
            headers: this.options?.headers,
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

  [Symbol.asyncIterator](): AsyncIterator<RunShape<TRunTypes>> {
    return this.stream[Symbol.asyncIterator]();
  }

  getReader(): ReadableStreamDefaultReader<RunShape<TRunTypes>> {
    return this.stream.getReader();
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
