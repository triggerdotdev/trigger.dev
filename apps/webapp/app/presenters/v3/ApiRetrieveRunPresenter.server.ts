import {
  AttemptStatus,
  RunStatus,
  SerializedError,
  TaskRunError,
  TriggerFunction,
  conditionallyImportPacket,
  createJsonErrorObject,
  logger,
} from "@trigger.dev/core/v3";
import { parsePacketAsJson } from "@trigger.dev/core/v3/utils/ioSerialization";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import { getUserProvidedIdempotencyKey } from "@trigger.dev/core/v3/serverOnly";
import { Prisma, TaskRunAttemptStatus, TaskRunStatus } from "@trigger.dev/database";
import assertNever from "assert-never";
import { API_VERSIONS, CURRENT_API_VERSION, RunStatusUnspecifiedApiVersion } from "~/api/versions";
import { $replica, prisma } from "~/db.server";
import { regionForDisplay } from "~/runEngine/concerns/workerQueueSplit.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  findRunByIdWithMollifierFallback,
  type SyntheticRun,
} from "~/v3/mollifier/readFallback.server";
import { generatePresignedUrl } from "~/v3/objectStore.server";
import { runStore } from "~/v3/runStore.server";
import { hydrateParentAndRoot, hydrateChildRuns } from "~/v3/runHierarchy.server";
import { v2RunsMayExist } from "~/v3/runTableV2Status.server";
import { env as serverEnv } from "~/env.server";
import { tracer } from "~/v3/tracer.server";
import { startSpanWithEnv } from "~/v3/tracing.server";

// Build 'select' object
const commonRunSelect = {
  id: true,
  friendlyId: true,
  status: true,
  taskIdentifier: true,
  createdAt: true,
  startedAt: true,
  updatedAt: true,
  completedAt: true,
  expiredAt: true,
  delayUntil: true,
  metadata: true,
  metadataType: true,
  ttl: true,
  costInCents: true,
  baseCostInCents: true,
  usageDurationMs: true,
  idempotencyKey: true,
  idempotencyKeyOptions: true,
  isTest: true,
  depth: true,
  scheduleId: true,
  workerQueue: true,
  region: true,
  lockedToVersion: {
    select: {
      version: true,
    },
  },
  resumeParentOnCompletion: true,
  batch: {
    select: {
      id: true,
      friendlyId: true,
    },
  },
  runTags: true,
} satisfies Prisma.TaskRunSelect;

type CommonRelatedRun = Prisma.Result<
  typeof prisma.taskRun,
  { select: typeof commonRunSelect },
  "findFirstOrThrow"
>;

// Full shape returned by findRun() — the commonRunSelect fields plus the
// extras the route handler reads. Declared explicitly (not inferred via
// ReturnType<typeof findRun>) so findRun can return a synthesised buffered
// run without the type becoming self-referential.
// Exported so the buffer-synthesis helper below can be unit-tested
// against a stable shape without re-deriving it (FoundRun's exact field
// list is what the buffered run must match for `call()` not to surprise).
export type FoundRun = CommonRelatedRun & {
  traceId: string;
  payload: string;
  payloadType: string;
  output: string | null;
  outputType: string;
  error: Prisma.JsonValue;
  attempts: { id: string }[];
  attemptNumber: number | null;
  engine: "V1" | "V2";
  taskEventStore: string;
  parentTaskRun: CommonRelatedRun | null;
  rootTaskRun: CommonRelatedRun | null;
  childRuns: CommonRelatedRun[];
  // True when this run was synthesised from the mollifier buffer rather
  // than read from Postgres. Callers that would otherwise query backing
  // stores keyed on PG identifiers (e.g. ClickHouse event lookups by
  // traceId) can short-circuit to an empty response — buffered runs
  // haven't executed and have no events to fetch. Devin's analysis on
  // PR #3755 (events endpoint) flagged the pre-fix code as making a
  // wasted ClickHouse round-trip when this is set; gate on this flag
  // instead.
  isBuffered: boolean;
};

export class ApiRetrieveRunPresenter {
  constructor(private readonly apiVersion: API_VERSIONS) {}

  public static async findRun(
    friendlyId: string,
    env: AuthenticatedEnvironment,
  ): Promise<FoundRun | null> {
    const pgRow = await runStore.findRun(
      {
        friendlyId,
        runtimeEnvironmentId: env.id,
      },
      {
        select: {
          ...commonRunSelect,
          traceId: true,
          payload: true,
          payloadType: true,
          output: true,
          outputType: true,
          error: true,
          attempts: {
            select: {
              id: true,
            },
          },
          attemptNumber: true,
          engine: true,
          taskEventStore: true,
          parentTaskRunId: true,
          rootTaskRunId: true,
        },
      },
      $replica
    );

    if (pgRow) {
      // Resolve parent/root/children across both run tables. A single Prisma
      // relation select is table-bound, so a v2 run's legacy parent (or a
      // legacy run's v2 children), which arise in the mixed window, would come
      // back null/empty. Resolve parent/root by id (RunStore routes by format)
      // and children by a both-table predicate.
      // Scope the cross-table reads on whether a v2 run could exist at all, NOT
      // the org's current flag: a run's table is fixed by its id format, and an
      // org that was on v2 then flipped off still HAS v2 runs (and v2 children)
      // that stay readable. pgRow is routed here by id format, so it can be a v2
      // run for a now-non-v2 org; scoping to "legacy" would then silently drop
      // its v2 children/parent. v2RunsMayExist is monotonic (native on now, OR
      // task_run_v2 already has rows), so turning the native master switch off
      // does not re-scope to legacy and hide existing v2 runs. While no v2 run
      // has ever existed it stays "legacy" and skips the empty task_run_v2 query.
      // The reads also run in parallel.
      const tables = v2RunsMayExist(serverEnv.REALTIME_BACKEND_NATIVE_ENABLED === "1")
        ? "both"
        : "legacy";
      const [{ parentTaskRun, rootTaskRun }, childRuns] = await Promise.all([
        hydrateParentAndRoot(
          { parentTaskRunId: pgRow.parentTaskRunId, rootTaskRunId: pgRow.rootTaskRunId },
          { runtimeEnvironmentId: env.id, tables },
          commonRunSelect,
          $replica
        ),
        hydrateChildRuns(pgRow.id, { runtimeEnvironmentId: env.id, tables }, commonRunSelect, $replica),
      ]);

      return { ...pgRow, parentTaskRun, rootTaskRun, childRuns, isBuffered: false };
    }

    // Postgres miss → fall back to the mollifier buffer. When the gate
    // diverted a trigger, the run lives in Redis until the drainer replays
    // it through engine.trigger. Synthesise the FoundRun shape so call()
    // returns a `QUEUED` (or `FAILED`) response with empty output, no
    // attempts, no relations.
    const buffered = await findRunByIdWithMollifierFallback({
      runId: friendlyId,
      environmentId: env.id,
      organizationId: env.organizationId,
    });

    if (!buffered) return null;

    return synthesiseFoundRunFromBuffer(buffered);
  }

  public async call(taskRun: FoundRun, env: AuthenticatedEnvironment) {
    return startSpanWithEnv(tracer, "ApiRetrieveRunPresenter.call", env, async () => {
      let $payload: any;
      let $payloadPresignedUrl: string | undefined;
      let $output: any;
      let $outputPresignedUrl: string | undefined;

      const payloadPacket = await conditionallyImportPacket({
        data: taskRun.payload,
        dataType: taskRun.payloadType,
      });

      if (
        payloadPacket.dataType === "application/store" &&
        typeof payloadPacket.data === "string"
      ) {
        const signed = await generatePresignedUrl(
          env.project.externalRef,
          env.slug,
          payloadPacket.data,
          "GET"
        );

        if (signed.success) {
          $payloadPresignedUrl = signed.url;
        } else {
          logger.error(`Failed to generate presigned URL for payload: ${signed.error}`, {
            taskRunId: taskRun.id,
            payload: payloadPacket.data,
          });
        }
      } else {
        $payload = await parsePacketAsJson(payloadPacket);
      }

      if (taskRun.status === "COMPLETED_SUCCESSFULLY") {
        const outputPacket = await conditionallyImportPacket({
          data: taskRun.output ?? undefined,
          dataType: taskRun.outputType,
        });

        if (
          outputPacket.dataType === "application/store" &&
          typeof outputPacket.data === "string"
        ) {
          const signed = await generatePresignedUrl(
            env.project.externalRef,
            env.slug,
            outputPacket.data,
            "GET"
          );

          if (signed.success) {
            $outputPresignedUrl = signed.url;
          } else {
            logger.error(`Failed to generate presigned URL for output: ${signed.error}`, {
              taskRunId: taskRun.id,
              output: outputPacket.data,
            });
          }
        } else {
          $output = await parsePacketAsJson(outputPacket);
        }
      }

      return {
        ...(await createCommonRunStructure(taskRun, this.apiVersion)),
        payload: $payload,
        payloadPresignedUrl: $payloadPresignedUrl,
        output: $output,
        outputPresignedUrl: $outputPresignedUrl,
        error: ApiRetrieveRunPresenter.apiErrorFromError(taskRun.error),
        schedule: await resolveSchedule(taskRun),
        // We're removing attempts from the API
        attemptCount:
          taskRun.engine === "V1" ? taskRun.attempts.length : taskRun.attemptNumber ?? 0,
        attempts: [],
        relatedRuns: {
          root: taskRun.rootTaskRun
            ? await createCommonRunStructure(taskRun.rootTaskRun, this.apiVersion)
            : undefined,
          parent: taskRun.parentTaskRun
            ? await createCommonRunStructure(taskRun.parentTaskRun, this.apiVersion)
            : undefined,
          children: await Promise.all(
            taskRun.childRuns.map(async (r) => await createCommonRunStructure(r, this.apiVersion))
          ),
        },
      };
    });
  }

  static apiErrorFromError(error: Prisma.JsonValue): SerializedError | undefined {
    if (!error) {
      return;
    }

    const errorData = TaskRunError.safeParse(error);

    if (errorData.success) {
      return createJsonErrorObject(errorData.data);
    }
  }

  static isStatusFinished(status: RunStatus | RunStatusUnspecifiedApiVersion) {
    return (
      status === "COMPLETED" ||
      status === "FAILED" ||
      status === "CANCELED" ||
      status === "INTERRUPTED" ||
      status === "CRASHED" ||
      status === "SYSTEM_FAILURE"
    );
  }

  static apiStatusFromRunStatus(
    status: TaskRunStatus,
    apiVersion: API_VERSIONS
  ): RunStatus | RunStatusUnspecifiedApiVersion {
    switch (apiVersion) {
      case CURRENT_API_VERSION: {
        return this.apiStatusFromRunStatusV2(status);
      }
      default: {
        return this.apiStatusFromRunStatusV1(status);
      }
    }
  }

  static apiStatusFromRunStatusV1(status: TaskRunStatus): RunStatusUnspecifiedApiVersion {
    switch (status) {
      case "DELAYED": {
        return "DELAYED";
      }
      case "PENDING_VERSION": {
        return "PENDING_VERSION";
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
      case "DEQUEUED":
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
      case "TIMED_OUT": {
        return "TIMED_OUT";
      }
      default: {
        assertNever(status);
      }
    }
  }

  static apiStatusFromRunStatusV2(status: TaskRunStatus): RunStatus {
    switch (status) {
      case "DELAYED": {
        return "DELAYED";
      }
      case "PENDING_VERSION": {
        return "PENDING_VERSION";
      }
      case "WAITING_FOR_DEPLOY": {
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
        assertNever(status);
      }
    }
  }

  static apiBooleanHelpersFromTaskRunStatus(status: TaskRunStatus, apiVersion: API_VERSIONS) {
    return ApiRetrieveRunPresenter.apiBooleanHelpersFromRunStatus(
      ApiRetrieveRunPresenter.apiStatusFromRunStatus(status, apiVersion)
    );
  }

  static apiBooleanHelpersFromRunStatus(status: RunStatus | RunStatusUnspecifiedApiVersion) {
    const isQueued =
      status === "QUEUED" ||
      status === "WAITING_FOR_DEPLOY" ||
      status === "DELAYED" ||
      status === "PENDING_VERSION";
    const isExecuting =
      status === "EXECUTING" ||
      status === "REATTEMPTING" ||
      status === "FROZEN" ||
      status === "DEQUEUED";
    const isCompleted =
      status === "COMPLETED" ||
      status === "CANCELED" ||
      status === "FAILED" ||
      status === "CRASHED" ||
      status === "INTERRUPTED" ||
      status === "SYSTEM_FAILURE";
    const isFailed = isCompleted && status !== "COMPLETED";
    const isSuccess = isCompleted && status === "COMPLETED";
    const isCancelled = status === "CANCELED";
    const isWaiting = status === "WAITING";

    return {
      isQueued,
      isExecuting,
      isCompleted,
      isFailed,
      isSuccess,
      isCancelled,
      isWaiting,
    };
  }

  static apiStatusFromAttemptStatus(status: TaskRunAttemptStatus): AttemptStatus {
    switch (status) {
      case "PENDING": {
        return "PENDING";
      }
      case "PAUSED": {
        return "PAUSED";
      }
      case "EXECUTING": {
        return "EXECUTING";
      }
      case "COMPLETED": {
        return "COMPLETED";
      }
      case "FAILED": {
        return "FAILED";
      }
      case "CANCELED": {
        return "CANCELED";
      }
      default: {
        assertNever(status);
      }
    }
  }
}

async function resolveSchedule(run: CommonRelatedRun) {
  if (!run.scheduleId) {
    return undefined;
  }

  const schedule = await prisma.taskSchedule.findFirst({
    where: {
      id: run.scheduleId,
    },
  });

  if (!schedule) {
    return undefined;
  }

  return {
    id: schedule.friendlyId,
    externalId: schedule.externalId ?? undefined,
    deduplicationKey: schedule.userProvidedDeduplicationKey ? schedule.deduplicationKey : undefined,
    generator: {
      type: "CRON" as const,
      expression: schedule.generatorExpression,
      description: schedule.generatorDescription,
    },
  };
}

async function createCommonRunStructure(run: CommonRelatedRun, apiVersion: API_VERSIONS) {
  const metadata = await parsePacketAsJson({
    data: run.metadata ?? undefined,
    dataType: run.metadataType,
  });

  return {
    id: run.friendlyId,
    taskIdentifier: run.taskIdentifier,
    idempotencyKey: getUserProvidedIdempotencyKey(run),
    version: run.lockedToVersion?.version,
    status: ApiRetrieveRunPresenter.apiStatusFromRunStatus(run.status, apiVersion),
    createdAt: run.createdAt,
    startedAt: run.startedAt ?? undefined,
    updatedAt: run.updatedAt,
    finishedAt: run.completedAt ?? undefined,
    expiredAt: run.expiredAt ?? undefined,
    delayedUntil: run.delayUntil ?? undefined,
    ttl: run.ttl ?? undefined,
    costInCents: run.costInCents,
    baseCostInCents: run.baseCostInCents,
    durationMs: run.usageDurationMs,
    isTest: run.isTest,
    depth: run.depth,
    tags: [...(run.runTags ?? [])].sort((a: string, b: string) => a.localeCompare(b)),
    ...ApiRetrieveRunPresenter.apiBooleanHelpersFromTaskRunStatus(run.status, apiVersion),
    triggerFunction: resolveTriggerFunction(run),
    batchId: run.batch?.friendlyId,
    metadata,
    region: regionForDisplay(run.region, run.workerQueue),
  };
}

function resolveTriggerFunction(run: CommonRelatedRun): TriggerFunction {
  if (run.batch) {
    return run.resumeParentOnCompletion ? "batchTriggerAndWait" : "batchTrigger";
  } else {
    return run.resumeParentOnCompletion ? "triggerAndWait" : "trigger";
  }
}

// Build a FoundRun-shaped object from a buffered (mollified) run. The run
// is in the Redis buffer; engine.trigger hasn't created the Postgres row
// yet, so every field that comes from execution state (output, attempts,
// completedAt, cost, relations) takes a default. The presenter's call()
// handles QUEUED-state runs without surprise.
function bufferedStatusToTaskRunStatus(status: SyntheticRun["status"]): TaskRunStatus {
  switch (status) {
    case "FAILED":
      return "SYSTEM_FAILURE";
    case "CANCELED":
      return "CANCELED";
    default:
      return "PENDING";
  }
}

// The PG path stores `TaskRun.payload` as `String?`, so in production
// the buffered snapshot's `payload` is always a string. We defensively
// coerce other types instead of silently dropping them: an object gets
// JSON-stringified (matches how the trigger path would serialise it),
// anything truly unrenderable falls back to an empty string. The log
// line surfaces format drift to ops without crashing the read path.
function synthesisePayload(buffered: SyntheticRun): string {
  const payload = buffered.payload;
  if (typeof payload === "string") return payload;
  if (payload === undefined || payload === null) return "";
  try {
    const serialised = JSON.stringify(payload);
    logger.warn("ApiRetrieveRunPresenter: buffered snapshot.payload non-string coerced", {
      runFriendlyId: buffered.friendlyId,
      payloadType: typeof payload,
    });
    return typeof serialised === "string" ? serialised : "";
  } catch {
    logger.error("ApiRetrieveRunPresenter: buffered snapshot.payload unserialisable", {
      runFriendlyId: buffered.friendlyId,
      payloadType: typeof payload,
    });
    return "";
  }
}

// Mirror synthesisePayload for metadata. The PG path stores
// `TaskRun.metadata` as `String?`, and the snapshot writes it from
// `metadataPacket.data` (also a string), so in production it is always a
// string or absent. We coerce defensively — an object gets JSON-stringified
// (matching how the trigger path serialises it) rather than silently
// dropped to null, and the log line surfaces format drift to ops.
function synthesiseMetadata(buffered: SyntheticRun): string | null {
  const metadata = buffered.metadata;
  if (typeof metadata === "string") return metadata;
  if (metadata === undefined || metadata === null) return null;
  try {
    const serialised = JSON.stringify(metadata);
    logger.warn("ApiRetrieveRunPresenter: buffered snapshot.metadata non-string coerced", {
      runFriendlyId: buffered.friendlyId,
      metadataType: typeof metadata,
    });
    return typeof serialised === "string" ? serialised : null;
  } catch {
    logger.error("ApiRetrieveRunPresenter: buffered snapshot.metadata unserialisable", {
      runFriendlyId: buffered.friendlyId,
      metadataType: typeof metadata,
    });
    return null;
  }
}

// Exported for unit testing. Used by `findRun()` above when the
// Postgres lookup misses and the buffer carries the run — keep the shape
// in lockstep with `FoundRun`'s field list so `call()` treats a synthesised
// buffered run identically to a freshly-triggered PG row.
export function synthesiseFoundRunFromBuffer(buffered: SyntheticRun): FoundRun {
  const status: TaskRunStatus = bufferedStatusToTaskRunStatus(buffered.status);

  const errorJson: Prisma.JsonValue = buffered.error
    ? {
        type: "STRING_ERROR",
        raw: `${buffered.error.code}: ${buffered.error.message}`,
      }
    : null;

  const metadata: string | null = synthesiseMetadata(buffered);

  return {
    // `id` is the internal cuid (Prisma TaskRun.id column), `friendlyId`
    // is the user-facing `run_xxx` token. Downstream logging keyed off
    // `taskRun.id` correlates with other systems via the cuid — using
    // the friendlyId here breaks log correlation. `SyntheticRun` carries
    // the cuid alongside the friendlyId for exactly this reason
    // (RunId.fromFriendlyId in readFallback.server.ts).
    id: buffered.id,
    friendlyId: buffered.friendlyId,
    status,
    taskIdentifier: buffered.taskIdentifier ?? "",
    createdAt: buffered.createdAt,
    startedAt: null,
    updatedAt: buffered.cancelledAt ?? buffered.createdAt,
    // PG-resident SYSTEM_FAILURE rows always have `completedAt` set by
    // the engine; the buffer-synth path must match so SDK consumers
    // that poll on `isCompleted` and then read `finishedAt` see a real
    // timestamp instead of `undefined`. CANCELED already had this via
    // `buffered.cancelledAt`; fall back to `buffered.createdAt` for
    // FAILED (the buffer entry has no separate "failedAt" — the
    // best-available approximation of when the terminal state landed
    // is the entry's creation time).
    completedAt:
      buffered.cancelledAt ?? (status === "SYSTEM_FAILURE" ? buffered.createdAt : null),
    expiredAt: null,
    delayUntil: buffered.delayUntil ?? null,
    metadata,
    metadataType: buffered.metadataType ?? "application/json",
    ttl: buffered.ttl ?? null,
    costInCents: 0,
    baseCostInCents: 0,
    usageDurationMs: 0,
    idempotencyKey: buffered.idempotencyKey ?? null,
    idempotencyKeyOptions: buffered.idempotencyKeyOptions ?? null,
    isTest: buffered.isTest,
    depth: buffered.depth,
    // Scheduled triggers go through the same TriggerTaskService path as
    // API triggers and aren't bypassed by the mollifier gate, so a
    // scheduled run can land in the buffer with its scheduleId set on the
    // snapshot. Forward it so resolveSchedule() can hydrate the `schedule`
    // field in the API response instead of silently dropping it until the
    // drainer materialises.
    scheduleId: buffered.scheduleId ?? null,
    lockedToVersion: buffered.lockedToVersion ? { version: buffered.lockedToVersion } : null,
    resumeParentOnCompletion: buffered.resumeParentOnCompletion,
    // Reconstruct the batch from the snapshot's internal id so a buffered
    // run reports the same `batchId` / triggerFunction as it will once
    // materialised, and so batch-scoped JWTs authorise against it (the
    // route authorization callbacks read `run.batch?.friendlyId`).
    batch: buffered.batchId
      ? { id: buffered.batchId, friendlyId: BatchId.toFriendlyId(buffered.batchId) }
      : null,
    runTags: buffered.tags,
    traceId: buffered.traceId ?? "",
    payload: synthesisePayload(buffered),
    payloadType: buffered.payloadType ?? "application/json",
    output: null,
    outputType: "application/json",
    error: errorJson,
    attempts: [],
    attemptNumber: null,
    engine: "V2",
    taskEventStore: "taskEvent",
    // Empty string when absent (matches syntheticSpanRun.server.ts and lets
    // `createCommonRunStructure`'s `run.workerQueue || undefined` coerce the
    // API response's `region` to undefined instead of advertising a
    // misleading "main" region for a not-yet-assigned buffered run).
    workerQueue: buffered.workerQueue ?? "",
    region: buffered.region ?? "",
    parentTaskRun: null,
    rootTaskRun: null,
    childRuns: [],
    isBuffered: true,
  };
}
