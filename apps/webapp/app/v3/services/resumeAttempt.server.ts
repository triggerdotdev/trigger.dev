import {
  CoordinatorToPlatformMessages,
  TaskRunExecution,
  TaskRunExecutionResult,
} from "@trigger.dev/core/v3";
import type { InferSocketMessageSchema } from "@trigger.dev/core/v3/zodSocket";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { socketIo } from "../handleSocketIo.server";
import { sharedQueueTasks } from "../marqs/sharedQueueConsumer.server";
import { BaseService } from "./baseService.server";
import { Prisma, TaskRunAttempt } from "@trigger.dev/database";
import { FINAL_ATTEMPT_STATUSES, FINAL_RUN_STATUSES, isFinalRunStatus } from "../taskStatus";

export class ResumeAttemptService extends BaseService {
  private _logger = logger;

  public async call(
    params: InferSocketMessageSchema<typeof CoordinatorToPlatformMessages, "READY_FOR_RESUME">
  ): Promise<void> {
    this._logger.debug(`ResumeAttemptService.call()`, params);

    const latestAttemptSelect = {
      orderBy: {
        number: "desc",
      },
      take: 1,
      select: {
        id: true,
        number: true,
        status: true,
      },
    } satisfies Prisma.TaskRunInclude["attempts"];

    const attempt = await this._prisma.taskRunAttempt.findFirst({
      where: {
        friendlyId: params.attemptFriendlyId,
      },
      include: {
        taskRun: true,
        dependencies: {
          select: {
            taskRun: {
              select: {
                attempts: latestAttemptSelect,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        },
        batchDependencies: {
          select: {
            items: {
              select: {
                taskRun: {
                  select: {
                    attempts: latestAttemptSelect,
                  },
                },
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        },
      },
    });

    if (!attempt) {
      this._logger.error("Could not find attempt", params);
      return;
    }

    this._logger = logger.child({
      attemptId: attempt.id,
      attemptFriendlyId: attempt.friendlyId,
      taskRun: attempt.taskRun,
    });

    if (isFinalRunStatus(attempt.taskRun.status)) {
      this._logger.error("Run is not resumable");
      return;
    }

    let completedAttemptIds: string[] = [];

    switch (params.type) {
      case "WAIT_FOR_DURATION": {
        this._logger.debug("Sending duration wait resume message");

        await this.#setPostResumeStatuses(attempt);

        socketIo.coordinatorNamespace.emit("RESUME_AFTER_DURATION", {
          version: "v1",
          attemptId: attempt.id,
          attemptFriendlyId: attempt.friendlyId,
        });
        break;
      }
      case "WAIT_FOR_TASK": {
        if (attempt.dependencies.length) {
          // We only care about the latest dependency
          const dependentAttempt = attempt.dependencies[0].taskRun.attempts[0];

          if (!dependentAttempt) {
            this._logger.error("No dependent attempt");
            return;
          }

          completedAttemptIds = [dependentAttempt.id];
        } else {
          this._logger.error("No task dependency");
          return;
        }

        await this.#handleDependencyResume(attempt, completedAttemptIds);

        break;
      }
      case "WAIT_FOR_BATCH": {
        if (attempt.batchDependencies) {
          // We only care about the latest batch dependency
          const dependentBatchItems = attempt.batchDependencies[0].items;

          if (!dependentBatchItems) {
            this._logger.error("No dependent batch items");
            return;
          }

          //find the best attempt for each batch item
          //it should be the most recent one in a final state
          const finalAttempts = dependentBatchItems
            .map((item) => {
              return item.taskRun.attempts
                .filter((a) => FINAL_ATTEMPT_STATUSES.includes(a.status))
                .sort((a, b) => b.number - a.number)
                .at(0);
            })
            .filter(Boolean);

          completedAttemptIds = finalAttempts.map((a) => a.id);

          if (completedAttemptIds.length !== dependentBatchItems.length) {
            this._logger.error("[ResumeAttemptService] not all batch items have attempts", {
              runId: attempt.taskRunId,
              completedAttemptIds,
              finalAttempts,
              dependentBatchItems,
            });

            return;
          }
        } else {
          this._logger.error("No batch dependency");
          return;
        }

        await this.#handleDependencyResume(attempt, completedAttemptIds);

        break;
      }
      default: {
        break;
      }
    }
  }

  async #handleDependencyResume(attempt: TaskRunAttempt, completedAttemptIds: string[]) {
    if (completedAttemptIds.length === 0) {
      this._logger.error("No completed attempt IDs");
      return;
    }

    const completions: TaskRunExecutionResult[] = [];
    const executions: TaskRunExecution[] = [];

    for (const completedAttemptId of completedAttemptIds) {
      const completedAttempt = await this._prisma.taskRunAttempt.findFirst({
        where: {
          id: completedAttemptId,
          taskRun: {
            lockedAt: {
              not: null,
            },
            lockedById: {
              not: null,
            },
          },
        },
      });

      if (!completedAttempt) {
        this._logger.error("Completed attempt not found", { completedAttemptId });
        await marqs?.acknowledgeMessage(
          attempt.taskRunId,
          "Cannot find completed attempt in ResumeAttemptService"
        );
        return;
      }

      const logger = this._logger.child({
        completedAttemptId: completedAttempt.id,
        completedAttemptFriendlyId: completedAttempt.friendlyId,
        completedRunId: completedAttempt.taskRunId,
      });

      const resumePayload = await sharedQueueTasks.getResumePayload(completedAttempt.id);

      if (!resumePayload) {
        logger.error("Failed to get resume payload");
        await marqs?.acknowledgeMessage(
          attempt.taskRunId,
          "Failed to get resume payload in ResumeAttemptService"
        );
        return;
      }

      completions.push(resumePayload.completion);
      executions.push(resumePayload.execution);
    }

    await this.#setPostResumeStatuses(attempt);

    socketIo.coordinatorNamespace.emit("RESUME_AFTER_DEPENDENCY", {
      version: "v1",
      runId: attempt.taskRunId,
      attemptId: attempt.id,
      attemptFriendlyId: attempt.friendlyId,
      completions,
      executions,
    });
  }

  async #setPostResumeStatuses(attempt: TaskRunAttempt) {
    try {
      const updatedAttempt = await this._prisma.taskRunAttempt.update({
        where: {
          id: attempt.id,
        },
        data: {
          status: "EXECUTING",
          taskRun: {
            update: {
              data: {
                status: attempt.number > 1 ? "RETRYING_AFTER_FAILURE" : "EXECUTING",
              },
            },
          },
        },
        select: {
          id: true,
          status: true,
          taskRun: {
            select: {
              id: true,
              status: true,
            },
          },
        },
      });

      this._logger.debug("Set post resume statuses", {
        run: {
          id: updatedAttempt.taskRun.id,
          status: updatedAttempt.taskRun.status,
        },
        attempt: {
          id: updatedAttempt.id,
          status: updatedAttempt.status,
        },
      });
    } catch (error) {
      this._logger.error("Failed to set post resume statuses", {
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
      });
    }
  }
}
