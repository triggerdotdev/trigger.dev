import {
  AttemptStatus,
  RetrieveRunResponse,
  RunStatus,
  SerializedError,
  TaskRunError,
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
          parentTaskRun: {
            select: {
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
            },
          },
          rootTaskRun: {
            select: {
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
            },
          },
          childRuns: {
            select: {
              id: true,
              taskIdentifier: true,
              friendlyId: true,
              resumeParentOnCompletion: true,
              status: true,
              createdAt: true,
              startedAt: true,
              updatedAt: true,
              completedAt: true,
              expiredAt: true,
              delayUntil: true,
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
              batch: {
                select: {
                  id: true,
                  friendlyId: true,
                },
              },
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

      const apiStatus = ApiRetrieveRunPresenter.apiStatusFromRunStatus(taskRun.status);

      return {
        id: taskRun.friendlyId,
        status: apiStatus,
        taskIdentifier: taskRun.taskIdentifier,
        idempotencyKey: taskRun.idempotencyKey ?? undefined,
        version: taskRun.lockedToVersion ? taskRun.lockedToVersion.version : undefined,
        createdAt: taskRun.createdAt ?? undefined,
        updatedAt: taskRun.updatedAt ?? undefined,
        startedAt: taskRun.startedAt ?? taskRun.lockedAt ?? undefined,
        finishedAt: ApiRetrieveRunPresenter.isStatusFinished(apiStatus)
          ? taskRun.updatedAt
          : undefined,
        delayedUntil: taskRun.delayUntil ?? undefined,
        payload: $payload,
        payloadPresignedUrl: $payloadPresignedUrl,
        output: $output,
        outputPresignedUrl: $outputPresignedUrl,
        isTest: taskRun.isTest,
        ttl: taskRun.ttl ?? undefined,
        expiredAt: taskRun.expiredAt ?? undefined,
        tags: taskRun.tags.map((t) => t.name).sort((a, b) => a.localeCompare(b)),
        costInCents: taskRun.costInCents,
        baseCostInCents: taskRun.baseCostInCents,
        durationMs: taskRun.usageDurationMs,
        depth: taskRun.depth,
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
        ...ApiRetrieveRunPresenter.apiBooleanHelpersFromRunStatus(apiStatus),
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
            ? {
                id: taskRun.rootTaskRun.friendlyId,
                taskIdentifier: taskRun.rootTaskRun.taskIdentifier,
                idempotencyKey: taskRun.rootTaskRun.idempotencyKey ?? undefined,
                version: taskRun.rootTaskRun.lockedToVersion?.version,
                status: ApiRetrieveRunPresenter.apiStatusFromRunStatus(taskRun.rootTaskRun.status),
                createdAt: taskRun.rootTaskRun.createdAt,
                startedAt: taskRun.rootTaskRun.startedAt ?? undefined,
                updatedAt: taskRun.rootTaskRun.updatedAt,
                finishedAt: taskRun.rootTaskRun.completedAt ?? undefined,
                expiredAt: taskRun.rootTaskRun.expiredAt ?? undefined,
                delayedUntil: taskRun.rootTaskRun.delayUntil ?? undefined,
                ttl: taskRun.rootTaskRun.ttl ?? undefined,
                costInCents: taskRun.rootTaskRun.costInCents,
                baseCostInCents: taskRun.rootTaskRun.baseCostInCents,
                durationMs: taskRun.rootTaskRun.usageDurationMs,
                isTest: taskRun.rootTaskRun.isTest,
                depth: taskRun.rootTaskRun.depth,
                tags: taskRun.rootTaskRun.tags
                  .map((t) => t.name)
                  .sort((a, b) => a.localeCompare(b)),
                ...ApiRetrieveRunPresenter.apiBooleanHelpersFromTaskRunStatus(
                  taskRun.rootTaskRun.status
                ),
              }
            : undefined,
          parent: taskRun.parentTaskRun
            ? {
                id: taskRun.parentTaskRun.friendlyId,
                taskIdentifier: taskRun.parentTaskRun.taskIdentifier,
                idempotencyKey: taskRun.parentTaskRun.idempotencyKey ?? undefined,
                version: taskRun.parentTaskRun.lockedToVersion?.version,
                status: ApiRetrieveRunPresenter.apiStatusFromRunStatus(
                  taskRun.parentTaskRun.status
                ),
                createdAt: taskRun.parentTaskRun.createdAt,
                startedAt: taskRun.parentTaskRun.startedAt ?? undefined,
                updatedAt: taskRun.parentTaskRun.updatedAt,
                finishedAt: taskRun.parentTaskRun.completedAt ?? undefined,
                expiredAt: taskRun.parentTaskRun.expiredAt ?? undefined,
                delayedUntil: taskRun.parentTaskRun.delayUntil ?? undefined,
                isRoot: taskRun.parentTaskRun.id === taskRun.rootTaskRun?.id,
                ttl: taskRun.parentTaskRun.ttl ?? undefined,
                costInCents: taskRun.parentTaskRun.costInCents,
                baseCostInCents: taskRun.parentTaskRun.baseCostInCents,
                durationMs: taskRun.parentTaskRun.usageDurationMs,
                isTest: taskRun.parentTaskRun.isTest,
                depth: taskRun.parentTaskRun.depth,
                tags: taskRun.parentTaskRun.tags
                  .map((t) => t.name)
                  .sort((a, b) => a.localeCompare(b)),
                ...ApiRetrieveRunPresenter.apiBooleanHelpersFromTaskRunStatus(
                  taskRun.parentTaskRun.status
                ),
              }
            : undefined,
          children: taskRun.childRuns.map((r) => ({
            id: r.friendlyId,
            taskIdentifier: r.taskIdentifier,
            idempotencyKey: r.idempotencyKey ?? undefined,
            version: r.lockedToVersion?.version,
            triggerFunction: r.batch
              ? r.resumeParentOnCompletion
                ? "batchTriggerAndWait"
                : "batchTrigger"
              : r.resumeParentOnCompletion
              ? "triggerAndWait"
              : "trigger",
            batchId: r.batch?.friendlyId,
            status: ApiRetrieveRunPresenter.apiStatusFromRunStatus(r.status),
            createdAt: r.createdAt,
            startedAt: r.startedAt ?? undefined,
            updatedAt: r.updatedAt,
            finishedAt: r.completedAt ?? undefined,
            expiredAt: r.expiredAt ?? undefined,
            delayedUntil: r.delayUntil ?? undefined,
            ttl: r.ttl ?? undefined,
            tags: r.tags.map((t) => t.name).sort((a, b) => a.localeCompare(b)),
            costInCents: r.costInCents,
            baseCostInCents: r.baseCostInCents,
            durationMs: r.usageDurationMs,
            depth: r.depth,
            isTest: r.isTest,
            ...ApiRetrieveRunPresenter.apiBooleanHelpersFromTaskRunStatus(r.status),
          })),
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
