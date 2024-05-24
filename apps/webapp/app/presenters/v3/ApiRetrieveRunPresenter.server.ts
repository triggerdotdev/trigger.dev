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
import { BasePresenter } from "./basePresenter.server";

export class ApiRetrieveRunPresenter extends BasePresenter {
  public async call(
    friendlyId: string,
    env: AuthenticatedEnvironment,
    showSecretDetails: boolean
  ): Promise<RetrieveRunResponse | undefined> {
    return this.traceWithEnv("call", env, async (span) => {
      const taskRun = await this._prisma.taskRun.findUnique({
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
        },
      });

      if (!taskRun) {
        logger.debug("Task run not found", { friendlyId, envId: env.id });

        return undefined;
      }

      let $payload: any;
      let $output: any;

      if (showSecretDetails) {
        const payloadPacket = await conditionallyImportPacket({
          data: taskRun.payload,
          dataType: taskRun.payloadType,
        });

        $payload =
          payloadPacket.dataType === "application/json"
            ? await parsePacket(payloadPacket)
            : payloadPacket.data;

        if (taskRun.status === "COMPLETED_SUCCESSFULLY") {
          const completedAttempt = taskRun.attempts.find(
            (a) => a.status === "COMPLETED" && typeof a.output !== null
          );

          if (completedAttempt && completedAttempt.output) {
            const outputPacket = await conditionallyImportPacket({
              data: completedAttempt.output,
              dataType: completedAttempt.outputType,
            });

            $output = await parsePacket(outputPacket);
          }
        }
      }

      return {
        id: taskRun.friendlyId,
        status: ApiRetrieveRunPresenter.apiStatusFromRunStatus(taskRun.status),
        taskIdentifier: taskRun.taskIdentifier,
        idempotencyKey: taskRun.idempotencyKey ?? undefined,
        version: taskRun.lockedToVersion ? taskRun.lockedToVersion.version : undefined,
        createdAt: taskRun.createdAt ?? undefined,
        updatedAt: taskRun.updatedAt ?? undefined,
        payload: $payload,
        output: $output,
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

  static apiStatusFromRunStatus(status: TaskRunStatus): RunStatus {
    switch (status) {
      case "WAITING_FOR_DEPLOY": {
        return "WAITING_FOR_DEPLOY";
      }
      case "PENDING": {
        return "QUEUED";
      }
      case "WAITING_TO_RESUME":
      case "RETRYING_AFTER_FAILURE": {
        return "REATTEMPTING";
      }
      case "EXECUTING": {
        return "EXECUTING";
      }
      case "PAUSED": {
        return "FROZEN";
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
      default: {
        assertNever(status);
      }
    }
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
