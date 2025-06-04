import {
  AttemptStatus,
  RetrieveRunResponse,
  RunStatus,
  SerializedError,
  TaskRunError,
  TriggerFunction,
  conditionallyImportPacket,
  createJsonErrorObject,
  logger,
  parsePacket,
} from "@trigger.dev/core/v3";
import { Prisma, TaskRunAttemptStatus, TaskRunStatus } from "@trigger.dev/database";
import assertNever from "assert-never";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { generatePresignedUrl } from "~/v3/r2.server";
import { BasePresenter } from "./basePresenter.server";
import { $replica, prisma } from "~/db.server";

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
  tags: true,
  costInCents: true,
  baseCostInCents: true,
  usageDurationMs: true,
  idempotencyKey: true,
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

type FoundRun = NonNullable<Awaited<ReturnType<typeof ApiRetrieveRunPresenter.findRun>>>;

export class ApiRetrieveRunPresenter extends BasePresenter {
  public static async findRun(friendlyId: string, env: AuthenticatedEnvironment) {
    return $replica.taskRun.findFirst({
      where: {
        friendlyId,
        runtimeEnvironmentId: env.id,
      },
      select: {
        ...commonRunSelect,
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
  }

  public async call(
    taskRun: FoundRun,
    env: AuthenticatedEnvironment
  ): Promise<RetrieveRunResponse | undefined> {
    return this.traceWithEnv("call", env, async (span) => {
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
        $payload = await parsePacket(payloadPacket);
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
          $output = await parsePacket(outputPacket);
        }
      }

      return {
        ...(await createCommonRunStructure(taskRun)),
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
            ? await createCommonRunStructure(taskRun.rootTaskRun)
            : undefined,
          parent: taskRun.parentTaskRun
            ? await createCommonRunStructure(taskRun.parentTaskRun)
            : undefined,
          children: await Promise.all(
            taskRun.childRuns.map(async (r) => await createCommonRunStructure(r))
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

  static isStatusFinished(status: RunStatus) {
    return (
      status === "COMPLETED" ||
      status === "FAILED" ||
      status === "CANCELED" ||
      status === "INTERRUPTED" ||
      status === "CRASHED" ||
      status === "SYSTEM_FAILURE"
    );
  }

  static apiStatusFromRunStatus(status: TaskRunStatus): RunStatus {
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

  static apiBooleanHelpersFromTaskRunStatus(status: TaskRunStatus) {
    return ApiRetrieveRunPresenter.apiBooleanHelpersFromRunStatus(
      ApiRetrieveRunPresenter.apiStatusFromRunStatus(status)
    );
  }

  static apiBooleanHelpersFromRunStatus(status: RunStatus) {
    const isQueued =
      status === "QUEUED" ||
      status === "WAITING_FOR_DEPLOY" ||
      status === "DELAYED" ||
      status === "PENDING_VERSION";
    const isExecuting = status === "EXECUTING" || status === "REATTEMPTING" || status === "FROZEN";
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

    return {
      isQueued,
      isExecuting,
      isCompleted,
      isFailed,
      isSuccess,
      isCancelled,
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

async function createCommonRunStructure(run: CommonRelatedRun) {
  const metadata = await parsePacket({
    data: run.metadata ?? undefined,
    dataType: run.metadataType,
  });

  return {
    id: run.friendlyId,
    taskIdentifier: run.taskIdentifier,
    idempotencyKey: run.idempotencyKey ?? undefined,
    version: run.lockedToVersion?.version,
    status: ApiRetrieveRunPresenter.apiStatusFromRunStatus(run.status),
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
    tags: run.tags
      .map((t: { name: string }) => t.name)
      .sort((a: string, b: string) => a.localeCompare(b)),
    ...ApiRetrieveRunPresenter.apiBooleanHelpersFromTaskRunStatus(run.status),
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
