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
import { getUserProvidedIdempotencyKey } from "@trigger.dev/core/v3/serverOnly";
import { Prisma, TaskRunAttemptStatus, TaskRunStatus } from "@trigger.dev/database";
import assertNever from "assert-never";
import { API_VERSIONS, CURRENT_API_VERSION, RunStatusUnspecifiedApiVersion } from "~/api/versions";
import { $replica, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  findRunByIdWithMollifierFallback,
  type SyntheticRun,
} from "~/v3/mollifier/readFallback.server";
import { generatePresignedUrl } from "~/v3/objectStore.server";
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
type FoundRun = CommonRelatedRun & {
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
};

export class ApiRetrieveRunPresenter {
  constructor(private readonly apiVersion: API_VERSIONS) {}

  public static async findRun(
    friendlyId: string,
    env: AuthenticatedEnvironment,
  ): Promise<FoundRun | null> {
    const pgRow = await $replica.taskRun.findFirst({
      where: {
        friendlyId,
        runtimeEnvironmentId: env.id,
      },
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
        parentTaskRun: {
          select: commonRunSelect,
        },
        rootTaskRun: {
          select: commonRunSelect,
        },
        childRuns: {
          select: commonRunSelect,
        },
      },
    });

    if (pgRow) return pgRow;

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
function synthesiseFoundRunFromBuffer(buffered: SyntheticRun): FoundRun {
  const status: TaskRunStatus =
    buffered.status === "FAILED" ? "SYSTEM_FAILURE" : "PENDING";

  const errorJson: Prisma.JsonValue = buffered.error
    ? {
        type: "STRING_ERROR",
        raw: `${buffered.error.code}: ${buffered.error.message}`,
      }
    : null;

  const metadata: Prisma.JsonValue =
    typeof buffered.metadata === "string" ? buffered.metadata : null;

  return {
    id: buffered.friendlyId,
    friendlyId: buffered.friendlyId,
    status,
    taskIdentifier: buffered.taskIdentifier ?? "",
    createdAt: buffered.createdAt,
    startedAt: null,
    updatedAt: buffered.createdAt,
    completedAt: null,
    expiredAt: null,
    delayUntil: null,
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
    scheduleId: null,
    lockedToVersion: buffered.lockedToVersion ? { version: buffered.lockedToVersion } : null,
    resumeParentOnCompletion: buffered.resumeParentOnCompletion,
    batch: null,
    runTags: buffered.tags,
    traceId: buffered.traceId ?? "",
    payload: typeof buffered.payload === "string" ? buffered.payload : "",
    payloadType: buffered.payloadType ?? "application/json",
    output: null,
    outputType: "application/json",
    error: errorJson,
    attempts: [],
    attemptNumber: null,
    engine: "V2",
    taskEventStore: "taskEvent",
    parentTaskRun: null,
    rootTaskRun: null,
    childRuns: [],
  };
}
