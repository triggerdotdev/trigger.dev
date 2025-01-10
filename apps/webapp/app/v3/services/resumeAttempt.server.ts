import {
  CoordinatorToPlatformMessages,
  TaskRunExecution,
  TaskRunExecutionResult,
} from "@trigger.dev/core/v3";
import type { InferSocketMessageSchema } from "@trigger.dev/core/v3/zodSocket";
import { $transaction, PrismaClientOrTransaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { socketIo } from "../handleSocketIo.server";
import { sharedQueueTasks } from "../marqs/sharedQueueConsumer.server";
import { BaseService } from "./baseService.server";
import { TaskRunAttempt } from "@trigger.dev/database";
import { isFinalRunStatus } from "../taskStatus";

export class ResumeAttemptService extends BaseService {
  private _logger = logger;

  public async call(
    params: InferSocketMessageSchema<typeof CoordinatorToPlatformMessages, "READY_FOR_RESUME">
  ): Promise<void> {
    this._logger.debug(`ResumeAttemptService.call()`, params);

    await $transaction(this._prisma, async (tx) => {
      const attempt = await tx.taskRunAttempt.findFirst({
        where: {
          friendlyId: params.attemptFriendlyId,
        },
        include: {
          taskRun: true,
          dependencies: {
            include: {
              taskRun: {
                include: {
                  attempts: {
                    orderBy: {
                      number: "desc",
                    },
                    take: 1,
                    select: {
                      id: true,
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
          batchDependencies: {
            include: {
              items: {
                include: {
                  taskRun: {
                    include: {
                      attempts: {
                        orderBy: {
                          number: "desc",
                        },
                        take: 1,
                        select: {
                          id: true,
                        },
                      },
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

          await this.#setPostResumeStatuses(attempt, tx);

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

          await this.#handleDependencyResume(attempt, completedAttemptIds, tx);

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

            completedAttemptIds = dependentBatchItems.map((item) => item.taskRun.attempts[0]?.id);
          } else {
            this._logger.error("No batch dependency");
            return;
          }

          await this.#handleDependencyResume(attempt, completedAttemptIds, tx);

          break;
        }
        default: {
          break;
        }
      }
    });
  }

  async #handleDependencyResume(
    attempt: TaskRunAttempt,
    completedAttemptIds: string[],
    tx: PrismaClientOrTransaction
  ) {
    if (completedAttemptIds.length === 0) {
      this._logger.error("No completed attempt IDs");
      return;
    }

    const completions: TaskRunExecutionResult[] = [];
    const executions: TaskRunExecution[] = [];

    for (const completedAttemptId of completedAttemptIds) {
      const completedAttempt = await tx.taskRunAttempt.findFirst({
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
        await marqs?.acknowledgeMessage(attempt.taskRunId);
        return;
      }

      const logger = this._logger.child({
        completedAttemptId: completedAttempt.id,
        completedAttemptFriendlyId: completedAttempt.friendlyId,
        completedRunId: completedAttempt.taskRunId,
      });

      const completion = await sharedQueueTasks.getCompletionPayloadFromAttempt(
        completedAttempt.id
      );

      if (!completion) {
        logger.error("Failed to get completion payload");
        await marqs?.acknowledgeMessage(attempt.taskRunId);
        return;
      }

      completions.push(completion);

      const executionPayload = await sharedQueueTasks.getExecutionPayloadFromAttempt({
        id: completedAttempt.id,
        skipStatusChecks: true, // already checked when getting the completion
      });

      if (!executionPayload) {
        logger.error("Failed to get execution payload");
        await marqs?.acknowledgeMessage(attempt.taskRunId);
        return;
      }

      executions.push(executionPayload.execution);
    }

    await this.#setPostResumeStatuses(attempt, tx);

    socketIo.coordinatorNamespace.emit("RESUME_AFTER_DEPENDENCY", {
      version: "v1",
      runId: attempt.taskRunId,
      attemptId: attempt.id,
      attemptFriendlyId: attempt.friendlyId,
      completions,
      executions,
    });
  }

  async #setPostResumeStatuses(attempt: TaskRunAttempt, tx: PrismaClientOrTransaction) {
    return await tx.taskRunAttempt.update({
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
    });
  }
}
