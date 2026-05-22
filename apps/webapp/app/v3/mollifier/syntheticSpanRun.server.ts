import { prettyPrintPacket, RunAnnotations } from "@trigger.dev/core/v3";
import { getMaxDuration } from "@trigger.dev/core/v3/isomorphic";
import {
  extractIdempotencyKeyScope,
  getUserProvidedIdempotencyKey,
} from "@trigger.dev/core/v3/serverOnly";
import type { SpanRun } from "~/presenters/v3/SpanPresenter.server";
import type { SyntheticRun } from "./readFallback.server";

// Synthesise a SpanRun-shaped object from a buffered run so the run-detail
// page's right-side details panel renders identically to a PG-resident
// run. The shape matches `SpanPresenter.getRun`'s return value exactly;
// buffered-irrelevant fields (output, error, attempts, schedule, session,
// region, batch) are filled with sensible defaults.
//
// Pretty-printing for payload and metadata mirrors SpanPresenter so the
// UI receives data in the same shape. Buffered runs cannot use the
// `application/store` packet path (no R2 object yet) so we treat raw
// snapshot fields as inline packets.
export async function buildSyntheticSpanRun(args: {
  run: SyntheticRun;
  environment: { id: string; slug: string; type: "PRODUCTION" | "DEVELOPMENT" | "STAGING" | "PREVIEW" };
}): Promise<SpanRun> {
  const { run, environment } = args;

  const payload =
    typeof run.payload !== "undefined" && run.payload !== null
      ? await prettyPrintPacket(run.payload, run.payloadType ?? undefined)
      : undefined;

  const metadata = run.metadata
    ? await prettyPrintPacket(run.metadata, run.metadataType, {
        filteredKeys: ["$$streams", "$$streamsVersion", "$$streamsBaseUrl"],
      })
    : undefined;

  const idempotencyShape = {
    idempotencyKey: run.idempotencyKey ?? null,
    idempotencyKeyExpiresAt: null,
    idempotencyKeyOptions: run.idempotencyKeyOptions ?? null,
  };

  const idempotencyKey = getUserProvidedIdempotencyKey(idempotencyShape);
  const idempotencyKeyScope = extractIdempotencyKeyScope(idempotencyShape);
  const idempotencyKeyStatus: SpanRun["idempotencyKeyStatus"] = idempotencyKey
    ? "active"
    : idempotencyKeyScope
    ? "inactive"
    : undefined;

  const taskKind = RunAnnotations.safeParse(run.annotations).data?.taskKind;
  const isAgentRun = taskKind === "AGENT";

  const queueName = run.queue ?? "task/";
  const isCancelled = run.status === "CANCELED";
  return {
    id: run.id,
    friendlyId: run.friendlyId,
    status: isCancelled ? "CANCELED" : "PENDING",
    statusReason: isCancelled ? run.cancelReason ?? undefined : undefined,
    createdAt: run.createdAt,
    startedAt: null,
    executedAt: null,
    updatedAt: run.cancelledAt ?? run.createdAt,
    delayUntil: run.delayUntil ?? null,
    expiredAt: null,
    completedAt: run.cancelledAt ?? null,
    logsDeletedAt: null,
    ttl: run.ttl ?? null,
    taskIdentifier: run.taskIdentifier ?? "",
    version: undefined,
    sdkVersion: undefined,
    runtime: undefined,
    runtimeVersion: undefined,
    isTest: run.isTest,
    replayedFromTaskRunFriendlyId: run.replayedFromTaskRunFriendlyId ?? null,
    environmentId: environment.id,
    idempotencyKey,
    idempotencyKeyExpiresAt: null,
    idempotencyKeyScope,
    idempotencyKeyStatus,
    debounce: null,
    schedule: undefined,
    queue: {
      name: queueName,
      isCustomQueue: !queueName.startsWith("task/"),
      concurrencyKey: run.concurrencyKey ?? null,
    },
    tags: run.runTags,
    baseCostInCents: 0,
    costInCents: 0,
    totalCostInCents: 0,
    usageDurationMs: 0,
    isFinished: false,
    isRunning: false,
    isError: false,
    isAgentRun,
    payload,
    payloadType: run.payloadType ?? "application/json",
    output: undefined,
    outputType: "application/json",
    error: undefined,
    relationships: {
      root: run.rootTaskRunFriendlyId
        ? {
            friendlyId: run.rootTaskRunFriendlyId,
            spanId: "",
            taskIdentifier: "",
            createdAt: run.createdAt,
            isParent: run.parentTaskRunFriendlyId === run.rootTaskRunFriendlyId,
          }
        : undefined,
      parent: run.parentTaskRunFriendlyId
        ? {
            friendlyId: run.parentTaskRunFriendlyId,
            spanId: "",
            taskIdentifier: "",
          }
        : undefined,
    },
    context: JSON.stringify(
      {
        task: {
          id: run.taskIdentifier ?? "",
        },
        run: {
          id: run.friendlyId,
          createdAt: run.createdAt,
          isTest: run.isTest,
        },
        environment: {
          id: environment.id,
          slug: environment.slug,
          type: environment.type,
        },
      },
      null,
      2,
    ),
    metadata,
    maxDurationInSeconds: getMaxDuration(run.maxDurationInSeconds),
    batch: undefined,
    session: undefined,
    engine: "V2",
    region: null,
    workerQueue: run.workerQueue ?? "",
    traceId: run.traceId ?? "",
    spanId: run.spanId ?? "",
    isCached: false,
    machinePreset: run.machinePreset,
    taskEventStore: "taskEvent",
    externalTraceId: undefined,
  };
}
