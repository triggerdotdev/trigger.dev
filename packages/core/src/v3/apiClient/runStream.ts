import { DeserializedJson } from "../../schemas/json.js";
import { RunStatus, SubscribeRunRawShape } from "../schemas/api.js";
import { SerializedError } from "../schemas/common.js";
import {
  conditionallyImportAndParsePacket,
  IOPacket,
  parsePacket,
} from "../utils/ioSerialization.js";
import { zodShapeStream } from "./stream.js";

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

export type RunStreamCallback<TPayload = any, TOutput = any> = (
  run: RunShape<TPayload, TOutput>
) => void | Promise<void>;

export async function runShapeStream<TPayload = any, TOutput = any>(
  url: string,
  fetchClient: typeof fetch,
  callback: RunStreamCallback<TPayload, TOutput>
) {
  const packetCache = new Map<string, any>();

  const abortController = new AbortController();

  abortController.signal.addEventListener("abort", () => {
    packetCache.clear();
  });

  const $callback = async (shape: SubscribeRunRawShape) => {
    const run = await transformRunShape(shape, packetCache);

    await callback(run);

    if (run.finishedAt) {
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    }
  };

  const unsubscribe = await zodShapeStream(SubscribeRunRawShape, url, $callback, {
    signal: abortController.signal,
    fetchClient: fetchClient,
  });

  return () => {
    packetCache.clear();
    unsubscribe();

    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };
}

async function transformRunShape(
  row: SubscribeRunRawShape,
  packetCache: Map<string, any>
): Promise<RunShape> {
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

      const cachedResult = packetCache.get(`${row.friendlyId}/${key}`);

      if (typeof cachedResult !== "undefined") {
        return cachedResult;
      }

      const result = await conditionallyImportAndParsePacket(packet);
      packetCache.set(`${row.friendlyId}/${key}`, result);

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
