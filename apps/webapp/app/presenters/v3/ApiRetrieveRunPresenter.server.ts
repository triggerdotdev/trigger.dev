import { AttemptStatus, RetrieveRunResponse, RunStatus, logger } from "@trigger.dev/core/v3";
import { TaskRunAttemptStatus, TaskRunStatus } from "@trigger.dev/database";
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

      return {
        id: taskRun.friendlyId,
        status: ApiRetrieveRunPresenter.apiStatusFromRunStatus(taskRun.status),
        taskIdentifier: taskRun.taskIdentifier,
        idempotencyKey: taskRun.idempotencyKey ?? undefined,
        version: taskRun.lockedToVersion ? taskRun.lockedToVersion.version : undefined,
        createdAt: taskRun.createdAt ?? undefined,
        updatedAt: taskRun.updatedAt ?? undefined,
        attempts: !showSecretDetails
          ? []
          : taskRun.attempts.map((a) => ({
              id: a.friendlyId,
              status: ApiRetrieveRunPresenter.apiStatusFromAttemptStatus(a.status),
              createdAt: a.createdAt ?? undefined,
              updatedAt: a.updatedAt ?? undefined,
              startedAt: a.startedAt ?? undefined,
              completedAt: a.completedAt ?? undefined,
            })),
      };
    });
  }

  static apiStatusFromRunStatus(status: TaskRunStatus): RunStatus {
    switch (status) {
      case "WAITING_FOR_DEPLOY":
      case "PENDING": {
        return "PENDING";
      }
      case "RETRYING_AFTER_FAILURE":
      case "EXECUTING": {
        return "EXECUTING";
      }
      case "WAITING_TO_RESUME":
      case "PAUSED": {
        return "PAUSED";
      }
      case "CANCELED": {
        return "CANCELED";
      }
      case "COMPLETED_SUCCESSFULLY": {
        return "COMPLETED";
      }
      case "SYSTEM_FAILURE":
      case "INTERRUPTED":
      case "CRASHED":
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
