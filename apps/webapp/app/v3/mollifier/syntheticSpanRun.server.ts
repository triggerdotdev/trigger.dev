import { prettyPrintPacket, RunAnnotations } from "@trigger.dev/core/v3";
import { getMaxDuration } from "@trigger.dev/core/v3/isomorphic";
import {
  extractIdempotencyKeyScope,
  getUserProvidedIdempotencyKey,
} from "@trigger.dev/core/v3/serverOnly";
import { MachinePresetName } from "@trigger.dev/core/v3/schemas";
import type { SpanRun } from "~/presenters/v3/SpanPresenter.server";
import type { SyntheticRun } from "./readFallback.server";

// `SyntheticRun.machinePreset` is sourced from the snapshot payload as
// a plain string, but `SpanRun.machinePreset` is the narrowed enum.
// Validate against the canonical enum so an unknown / stale preset
// string collapses to undefined rather than fighting the type checker.
function narrowMachinePreset(value: string | undefined): SpanRun["machinePreset"] {
  if (value === undefined) return undefined;
  const parsed = MachinePresetName.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

// Synthesise a SpanRun-shaped object from a buffered run so the run-detail
// page's right-side details panel renders identically to a PG-resident
// run. The shape matches `SpanPresenter.getRun`'s return value;
// buffered-irrelevant fields (output, attempts, schedule, session,
// region, batch) are filled with sensible defaults, while terminal state
// (CANCELED / FAILED) is reflected into `status`, `isFinished`, `isError`
// and `error` so a finished buffered run does not render as PENDING.
//
// Pretty-printing for payload and metadata mirrors SpanPresenter so the
// UI receives data in the same shape. Buffered runs cannot use the
// `application/store` packet path (no R2 object yet) so we treat raw
// snapshot fields as inline packets.
export async function buildSyntheticSpanRun(args: {
  run: SyntheticRun;
  environment: {
    id: string;
    slug: string;
    type: "PRODUCTION" | "DEVELOPMENT" | "STAGING" | "PREVIEW";
  };
}): Promise<SpanRun> {
  const { run, environment } = args;

  const payload =
    typeof run.payload !== "undefined" && run.payload !== null
      ? await prettyPrintPacket(run.payload, run.payloadType ?? undefined)
      : undefined;

  // Nullish check, not truthy — matches the payload branch above so an
  // intentionally-empty packet (e.g. metadata: "") still gets handed to
  // `prettyPrintPacket` and renders consistently. A truthy check would
  // drop the empty-string case and the two paths would diverge.
  const metadata =
    typeof run.metadata !== "undefined" && run.metadata !== null
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
  const isScheduled = taskKind === "SCHEDULED";

  const queueName = run.queue ?? "task/";
  const isCancelled = run.status === "CANCELED";
  const isFailed = run.status === "FAILED";

  // The run-detail panel derives terminal/error state from `status`,
  // `isFinished` and `isError` (SpanPresenter.getRun -> isFinalRunStatus /
  // isFailedRunStatus). Buffered FAILED runs surface as SYSTEM_FAILURE to
  // match ApiRetrieveRunPresenter.bufferedStatusToTaskRunStatus; both
  // CANCELED and SYSTEM_FAILURE are final run statuses, and SYSTEM_FAILURE
  // is also a failed status.
  const status: SpanRun["status"] = isCancelled
    ? "CANCELED"
    : isFailed
      ? "SYSTEM_FAILURE"
      : "PENDING";

  // Mirror ApiRetrieveRunPresenter's STRING_ERROR synthesis so the panel
  // shows why a buffered run failed instead of an empty error block.
  const error: SpanRun["error"] =
    isFailed && run.error
      ? { type: "STRING_ERROR", raw: `${run.error.code}: ${run.error.message}` }
      : undefined;

  return {
    id: run.id,
    friendlyId: run.friendlyId,
    status,
    statusReason: isCancelled
      ? (run.cancelReason ?? undefined)
      : isFailed
        ? (run.error?.message ?? undefined)
        : undefined,
    createdAt: run.createdAt,
    startedAt: null,
    executedAt: null,
    updatedAt: run.cancelledAt ?? run.createdAt,
    delayUntil: run.delayUntil ?? null,
    expiredAt: null,
    // Symmetric with `ApiRetrieveRunPresenter` — FAILED buffered runs
    // must surface a non-null `completedAt` so the run-detail panel
    // (and any caller checking `isFinished && completedAt`) doesn't
    // render a finished run with no completion timestamp. PG-resident
    // SYSTEM_FAILURE rows always have completedAt set; the buffer
    // entry has no separate failedAt, so we fall back to createdAt
    // as the best proxy for when the terminal state landed.
    completedAt: run.cancelledAt ?? (isFailed ? run.createdAt : null),
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
    isFinished: isCancelled || isFailed,
    isRunning: false,
    isError: isFailed,
    isAgentRun,
    isScheduled,
    payload,
    payloadType: run.payloadType ?? "application/json",
    output: undefined,
    outputType: "application/json",
    error,
    // The snapshot only carries the root/parent friendly IDs, not the
    // spanId or taskIdentifier that SpanPresenter sources from the joined
    // PG rows. Emitting them with empty-string stubs renders a blank task
    // name and a misleading `?span=` jump target, so we omit the
    // relationships until the drainer materialises the row (a transient
    // window). Top-level buffered runs have no relationships regardless.
    relationships: {
      root: undefined,
      parent: undefined,
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
      2
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
    isBuffered: true,
    machinePreset: narrowMachinePreset(run.machinePreset),
    taskEventStore: "taskEvent",
    externalTraceId: undefined,
  };
}
