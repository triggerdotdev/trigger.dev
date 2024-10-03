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
import { prisma } from "~/db.server";

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
} satisfies Prisma.TaskRunSelect;

type CommonRelatedRun = Prisma.Result<
  typeof prisma.taskRun,
  { select: typeof commonRunSelect },
  "findFirstOrThrow"
>;

export class ApiRetrieveRunPresenter extends BasePresenter {
  public async call(
    friendlyId: string,
    env: AuthenticatedEnvironment,
    showSecretDetails: boolean
  ): Promise<RetrieveRunResponse | undefined> {
    return this.traceWithEnv("call", env, async (span) => {
      const taskRun = await this._replica.taskRun.findFirst({
        where: {
          friendlyId,
          runtimeEnvironmentId: env.id,
        },
        include: {
          attempts: {
            orderBy: {
              createdAt: "desc",
            },
          },
          lockedToVersion: true,
          schedule: true,
          tags: true,
          batch: {
            select: {
              id: true,
              friendlyId: true,
            },
          },
          parentTaskRun: {
            select: commonRunSelect,
          },
          rootTaskRun: {
            select: commonRunSelect,
          },
          childRuns: {
            select: {
              ...commonRunSelect,
            },
          },
        },
      });

      if (!taskRun) {
        logger.debug("Task run not found", { friendlyId, envId: env.id });

        return undefined;
      }

      let $payload: any;
      let $payloadPresignedUrl: string | undefined;
      let $output: any;
      let $outputPresignedUrl: string | undefined;

      if (showSecretDetails) {
        const payloadPacket = await conditionallyImportPacket({
          data: taskRun.payload,
          dataType: taskRun.payloadType,
        });

        if (
          payloadPacket.dataType === "application/store" &&
          typeof payloadPacket.data === "string"
        ) {
          $payloadPresignedUrl = await generatePresignedUrl(
            env.project.externalRef,
            env.slug,
            payloadPacket.data,
            "GET"
          );
        } else {
          $payload = await parsePacket(payloadPacket);
        }

        if (taskRun.status === "COMPLETED_SUCCESSFULLY") {
          const completedAttempt = taskRun.attempts.find(
            (a) => a.status === "COMPLETED" && typeof a.output !== null
          );

          if (completedAttempt && completedAttempt.output) {
            const outputPacket = await conditionallyImportPacket({
              data: completedAttempt.output,
              dataType: completedAttempt.outputType,
            });

            if (
              outputPacket.dataType === "application/store" &&
              typeof outputPacket.data === "string"
            ) {
              $outputPresignedUrl = await generatePresignedUrl(
                env.project.externalRef,
                env.slug,
                outputPacket.data,
                "GET"
              );
            } else {
              $output = await parsePacket(outputPacket);
            }
          }
        }
      }

      return {
        ...(await createCommonRunStructure(taskRun)),
        payload: $payload,
        payloadPresignedUrl: $payloadPresignedUrl,
        output: $output,
        outputPresignedUrl: $outputPresignedUrl,
        schedule: taskRun.schedule
          ? {
              id: taskRun.schedule.friendlyId,
              externalId: taskRun.schedule.externalId ?? undefined,
              deduplicationKey: taskRun.schedule.userProvidedDeduplicationKey
                ? taskRun.schedule.deduplicationKey
                : undefined,
              generator: {
                type: "CRON" as const,
                expression: taskRun.schedule.generatorExpression,
                description: taskRun.schedule.generatorDescription,
              },
            }
          : undefined,
        attempts: !showSecretDetails
          ? []
          : taskRun.attempts.map((a) => ({
              id: a.friendlyId,
              status: ApiRetrieveRunPresenter.apiStatusFromAttemptStatus(a.status),
              createdAt: a.createdAt ?? undefined,
              updatedAt: a.updatedAt ?? undefined,
              startedAt: a.startedAt ?? undefined,
              completedAt: a.completedAt ?? undefined,
              error: ApiRetrieveRunPresenter.apiErrorFromError(a.error),
            })),
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
        return "MAX_DURATION_EXCEEDED";
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
    const isQueued = status === "QUEUED" || status === "WAITING_FOR_DEPLOY" || status === "DELAYED";
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
