import { DeserializedJson } from "@trigger.dev/core";
import type {
  ApiRequestOptions,
  ListProjectRunsQueryParams,
  ListRunsQueryParams,
  RescheduleRunRequestBody,
  RunStatus,
  SerializedError,
} from "@trigger.dev/core/v3";
import {
  ApiPromise,
  CanceledRunResponse,
  CursorPagePromise,
  ListRunResponseItem,
  ReplayRunResponse,
  RetrieveRunResponse,
  accessoryAttributes,
  apiClientManager,
  flattenAttributes,
  isRequestOptions,
  mergeRequestOptions,
} from "@trigger.dev/core/v3";
import {
  conditionallyImportAndParsePacket,
  parsePacket,
  resolvePresignedPacketUrl,
} from "@trigger.dev/core/v3/utils/ioSerialization";
import { IOPacket } from "../../../core/dist/commonjs/v3/index.js";
import { AnyRunHandle, AnyTask, Prettify, RunHandle, Task } from "./shared.js";
import { tracer } from "./tracer.js";

export type RetrieveRunResult<TPayload = any, TOutput = any> = Prettify<
  Omit<RetrieveRunResponse, "output" | "payload"> & {
    output?: TOutput;
    payload?: TPayload;
  }
>;

export const runs = {
  replay: replayRun,
  cancel: cancelRun,
  retrieve: retrieveRun,
  list: listRuns,
  reschedule: rescheduleRun,
  poll,
  subscribe: subscribeToRun,
};

export type ListRunsItem = ListRunResponseItem;

function listRuns(
  projectRef: string,
  params?: ListProjectRunsQueryParams,
  requestOptions?: ApiRequestOptions
): CursorPagePromise<typeof ListRunResponseItem>;
function listRuns(
  params?: ListRunsQueryParams,
  requestOptions?: ApiRequestOptions
): CursorPagePromise<typeof ListRunResponseItem>;
function listRuns(
  paramsOrProjectRef?: ListRunsQueryParams | string,
  paramsOrOptions?: ListRunsQueryParams | ListProjectRunsQueryParams | ApiRequestOptions,
  requestOptions?: ApiRequestOptions
): CursorPagePromise<typeof ListRunResponseItem> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = listRunsRequestOptions(
    paramsOrProjectRef,
    paramsOrOptions,
    requestOptions
  );

  if (typeof paramsOrProjectRef === "string") {
    if (isRequestOptions(paramsOrOptions)) {
      return apiClient.listProjectRuns(paramsOrProjectRef, {}, $requestOptions);
    } else {
      return apiClient.listProjectRuns(paramsOrProjectRef, paramsOrOptions, $requestOptions);
    }
  }

  return apiClient.listRuns(paramsOrProjectRef, $requestOptions);
}

function listRunsRequestOptions(
  paramsOrProjectRef?: ListRunsQueryParams | string,
  paramsOrOptions?: ListRunsQueryParams | ListProjectRunsQueryParams | ApiRequestOptions,
  requestOptions?: ApiRequestOptions
): ApiRequestOptions {
  if (typeof paramsOrProjectRef === "string") {
    if (isRequestOptions(paramsOrOptions)) {
      return mergeRequestOptions(
        {
          tracer,
          name: "runs.list()",
          icon: "runs",
          attributes: {
            projectRef: paramsOrProjectRef,
            ...accessoryAttributes({
              items: [
                {
                  text: paramsOrProjectRef,
                  variant: "normal",
                },
              ],
              style: "codepath",
            }),
          },
        },
        paramsOrOptions
      );
    } else {
      return mergeRequestOptions(
        {
          tracer,
          name: "runs.list()",
          icon: "runs",
          attributes: {
            projectRef: paramsOrProjectRef,
            ...flattenAttributes(paramsOrOptions as Record<string, unknown>, "queryParams"),
            ...accessoryAttributes({
              items: [
                {
                  text: paramsOrProjectRef,
                  variant: "normal",
                },
              ],
              style: "codepath",
            }),
          },
        },
        requestOptions
      );
    }
  }

  return mergeRequestOptions(
    {
      tracer,
      name: "runs.list()",
      icon: "runs",
      attributes: {
        ...flattenAttributes(paramsOrProjectRef as Record<string, unknown>, "queryParams"),
      },
    },
    isRequestOptions(paramsOrOptions) ? paramsOrOptions : requestOptions
  );
}

// Extract out the expected type of the id, can be either a string or a RunHandle
type RunId<TRunId> = TRunId extends AnyRunHandle
  ? TRunId
  : TRunId extends AnyTask
  ? string
  : TRunId extends string
  ? TRunId
  : never;

type InferRunId<TRunId> = TRunId extends RunHandle<infer TPayload, infer TOutput>
  ? { output?: TOutput; payload: TPayload }
  : TRunId extends Task<string, infer TTaskPayload, infer TTaskOutput>
  ? {
      output?: TTaskOutput;
      payload: TTaskPayload;
    }
  : { output?: any; payload: any };

function retrieveRun<TRunId extends AnyRunHandle | AnyTask | string>(
  runId: RunId<TRunId>,
  requestOptions?: ApiRequestOptions
): ApiPromise<RetrieveRunResult<InferRunId<TRunId>["payload"], InferRunId<TRunId>["output"]>> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "runs.retrieve()",
      icon: "runs",
      attributes: {
        runId: typeof runId === "string" ? runId : runId.id,
        ...accessoryAttributes({
          items: [
            {
              text: typeof runId === "string" ? runId : runId.id,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  const $runId = typeof runId === "string" ? runId : runId.id;

  return apiClient.retrieveRun($runId, $requestOptions).then((retrievedRun) => {
    return resolvePayloadAndOutputUrls(retrievedRun);
  }) as ApiPromise<RetrieveRunResult<TRunId>>;
}

async function resolvePayloadAndOutputUrls(run: RetrieveRunResult<any, any>) {
  const resolvedRun = { ...run };

  if (run.payloadPresignedUrl && run.outputPresignedUrl) {
    const [payload, output] = await Promise.all([
      resolvePresignedPacketUrl(run.payloadPresignedUrl, tracer),
      resolvePresignedPacketUrl(run.outputPresignedUrl, tracer),
    ]);

    resolvedRun.payload = payload;
    resolvedRun.output = output;
  } else if (run.payloadPresignedUrl) {
    resolvedRun.payload = await resolvePresignedPacketUrl(run.payloadPresignedUrl, tracer);
  } else if (run.outputPresignedUrl) {
    resolvedRun.output = await resolvePresignedPacketUrl(run.outputPresignedUrl, tracer);
  }

  return resolvedRun;
}

function replayRun(
  runId: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<ReplayRunResponse> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "runs.replay()",
      icon: "runs",
      attributes: {
        runId,
        ...accessoryAttributes({
          items: [
            {
              text: runId,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.replayRun(runId, $requestOptions);
}

function cancelRun(
  runId: string,
  requestOptions?: ApiRequestOptions
): ApiPromise<CanceledRunResponse> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "runs.cancel()",
      icon: "runs",
      attributes: {
        runId,
        ...accessoryAttributes({
          items: [
            {
              text: runId,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.cancelRun(runId, $requestOptions);
}

function rescheduleRun(
  runId: string,
  body: RescheduleRunRequestBody,
  requestOptions?: ApiRequestOptions
): ApiPromise<RetrieveRunResponse> {
  const apiClient = apiClientManager.clientOrThrow();

  const $requestOptions = mergeRequestOptions(
    {
      tracer,
      name: "runs.reschedule()",
      icon: "runs",
      attributes: {
        runId,
        ...accessoryAttributes({
          items: [
            {
              text: runId,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    },
    requestOptions
  );

  return apiClient.rescheduleRun(runId, body, $requestOptions);
}

export type PollOptions = { pollIntervalMs?: number };

const MAX_POLL_ATTEMPTS = 500;

async function poll<TRunId extends AnyRunHandle | AnyTask | string>(
  runId: RunId<TRunId>,
  options?: { pollIntervalMs?: number },
  requestOptions?: ApiRequestOptions
) {
  let attempts = 0;

  while (attempts++ < MAX_POLL_ATTEMPTS) {
    const run = await runs.retrieve(runId, requestOptions);

    if (run.isCompleted) {
      return run;
    }

    await new Promise((resolve) => setTimeout(resolve, options?.pollIntervalMs ?? 1000));
  }

  throw new Error(
    `Run ${
      typeof runId === "string" ? runId : runId.id
    } did not complete after ${MAX_POLL_ATTEMPTS} attempts`
  );
}

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

type RawRunShape = {
  id: string;
  idempotencyKey: string | null;
  payload: string | null;
  payloadType: string | null;
  createdAt: string;
  updatedAt: string;
  taskIdentifier: string;
  friendlyId: string;
  number: number;
  isTest: boolean;
  status: string;
  usageDurationMs: number;
  costInCents: number;
  baseCostInCents: number;
  startedAt: string | null;
  delayUntil: string | null;
  queuedAt: string | null;
  expiredAt: string | null;
  ttl: string | null;
  completedAt: string | null;
  metadata: string | null;
  metadataType: string | null;
  output: string | null;
  outputType: string | null;
  runTags: string[] | null;
  error?: any;
};

async function subscribeToRun<TRunId extends AnyRunHandle | AnyTask | string>(
  runId: RunId<TRunId>,
  callback: (
    run: Prettify<RunShape<InferRunId<TRunId>["payload"], InferRunId<TRunId>["output"]>>
  ) => void | Promise<void>
) {
  const $runId = typeof runId === "string" ? runId : runId.id;

  const { ShapeStream, Shape } = await import("@electric-sql/client");

  const abortController = new AbortController();

  const apiClient = apiClientManager.clientOrThrow();

  const stream = new ShapeStream<RawRunShape>({
    url: `${apiClient.baseUrl}/api/v1/shape/runs/${$runId}`,
    fetchClient: apiClient.fetchClient,
    signal: abortController.signal,
  });

  const packetCache = new Map<string, any>();

  const shape = new Shape(stream);

  const runShape = await shape.value;

  await callback(await transformRunShape(runShape, packetCache));

  const unsubscribe = shape.subscribe(async (newShape) => {
    const runShape = await transformRunShape(newShape, packetCache);

    await callback(runShape);

    if (isCompletedStatus(runShape.status)) {
      packetCache.clear();
      unsubscribe();
      abortController.abort();
    }
  });

  return () => {
    packetCache.clear();
    unsubscribe();
    abortController.abort();
  };
}

async function transformRunShape(
  runShape: Map<string, RawRunShape>,
  packetCache: Map<string, any>
): Promise<RunShape> {
  const row = Array.from(runShape.values())[0];

  if (!row) {
    throw new Error("Something went wrong");
  }

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
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    taskIdentifier: row.taskIdentifier,
    number: row.number,
    status: apiStatusFromRunStatus(row.status),
    durationMs: row.usageDurationMs,
    costInCents: row.costInCents,
    baseCostInCents: row.baseCostInCents,
    tags: row.runTags ?? [],
    idempotencyKey: row.idempotencyKey ?? undefined,
    expiredAt: row.expiredAt ? new Date(row.expiredAt) : undefined,
    finishedAt: row.completedAt ? new Date(row.completedAt) : undefined,
    startedAt: row.startedAt ? new Date(row.startedAt) : undefined,
    delayedUntil: row.delayUntil ? new Date(row.delayUntil) : undefined,
    queuedAt: row.queuedAt ? new Date(row.queuedAt) : undefined,
    error: row.error,
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
      throw new Error(`Run status ${status} is invalid`);
    }
  }
}

const COMPLETED_STATUSES: RunStatus[] = [
  "COMPLETED",
  "EXPIRED",
  "CANCELED",
  "FAILED",
  "CRASHED",
  "INTERRUPTED",
  "SYSTEM_FAILURE",
];

function isCompletedStatus(status: RunStatus): boolean {
  return COMPLETED_STATUSES.includes(status);
}
