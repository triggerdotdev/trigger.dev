import {
  CoordinatorToPlatformMessages,
  InferSocketMessageSchema,
  TaskRunExecution,
  TaskRunExecutionResult,
} from "@trigger.dev/core/v3";
import { $transaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { socketIo } from "../handleSocketIo.server";
import { sharedQueueTasks } from "../marqs/sharedQueueConsumer.server";
import { BaseService } from "./baseService.server";

export class ResumeAttemptService extends BaseService {
  public async call(
    params: InferSocketMessageSchema<typeof CoordinatorToPlatformMessages, "READY_FOR_RESUME">
  ): Promise<void> {
    logger.debug(`ResumeAttemptService.call()`, params);

    await $transaction(this._prisma, async (tx) => {
      const attempt = await tx.taskRunAttempt.findUnique({
        where: {
          friendlyId: params.attemptFriendlyId,
        },
        include: {
          taskRun: true,
          taskRunDependency: {
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
          batchTaskRunDependency: {
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
          },
        },
      });

      if (!attempt) {
        logger.error("Could not find attempt", { attemptFriendlyId: params.attemptFriendlyId });
        return;
      }

      if (attempt.taskRun.status !== "WAITING_TO_RESUME") {
        logger.error("Run is not resumable", {
          attemptId: attempt.id,
          runId: attempt.taskRunId,
        });
        return;
      }

      switch (params.type) {
        case "WAIT_FOR_DURATION": {
          logger.error(
            "Attempt requested resume after duration wait, this is unexpected and likely a bug",
            { attemptId: attempt.id }
          );

          // Attempts should not request resume for duration waits, this is just here as a backup
          socketIo.coordinatorNamespace.emit("RESUME_AFTER_DURATION", {
            version: "v1",
            attemptId: attempt.id,
            attemptFriendlyId: attempt.friendlyId,
          });
          break;
        }
        case "WAIT_FOR_TASK":
        case "WAIT_FOR_BATCH": {
          let completedAttemptIds: string[] = [];

          if (attempt.taskRunDependency) {
            const dependentAttempt = attempt.taskRunDependency.taskRun.attempts[0];

            if (!dependentAttempt) {
              logger.error("No dependent attempt", { attemptId: attempt.id });
              return;
            }

            completedAttemptIds = [dependentAttempt.id];

            await tx.taskRunAttempt.update({
              where: {
                id: attempt.id,
              },
              data: {
                taskRunDependency: {
                  disconnect: true,
                },
              },
            });
          } else if (attempt.batchTaskRunDependency) {
            const dependentBatchItems = attempt.batchTaskRunDependency.items;

            if (!dependentBatchItems) {
              logger.error("No dependent batch items", { attemptId: attempt.id });
              return;
            }

            completedAttemptIds = dependentBatchItems.map((item) => item.taskRun.attempts[0]?.id);

            await tx.taskRunAttempt.update({
              where: {
                id: attempt.id,
              },
              data: {
                batchTaskRunDependency: {
                  disconnect: true,
                },
              },
            });
          } else {
            logger.error("No dependencies", { attemptId: attempt.id });
            return;
          }

          if (completedAttemptIds.length === 0) {
            logger.error("No completed attempt IDs", { attemptId: attempt.id });
            return;
          }

          const completions: TaskRunExecutionResult[] = [];
          const executions: TaskRunExecution[] = [];

          for (const completedAttemptId of completedAttemptIds) {
            const completedAttempt = await tx.taskRunAttempt.findUnique({
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
              logger.error("Completed attempt not found", {
                attemptId: attempt.id,
                completedAttemptId,
              });
              await marqs?.acknowledgeMessage(attempt.taskRunId);
              return;
            }

            const completion = await sharedQueueTasks.getCompletionPayloadFromAttempt(
              completedAttempt.id
            );

            if (!completion) {
              logger.error("Failed to get completion payload", {
                attemptId: attempt.id,
                completedAttemptId,
              });
              await marqs?.acknowledgeMessage(attempt.taskRunId);
              return;
            }

            completions.push(completion);

            const executionPayload = await sharedQueueTasks.getExecutionPayloadFromAttempt(
              completedAttempt.id
            );

            if (!executionPayload) {
              logger.error("Failed to get execution payload", {
                attemptId: attempt.id,
                completedAttemptId,
              });
              await marqs?.acknowledgeMessage(attempt.taskRunId);
              return;
            }

            executions.push(executionPayload.execution);
          }

          const updated = await tx.taskRunAttempt.update({
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

          socketIo.coordinatorNamespace.emit("RESUME_AFTER_DEPENDENCY", {
            version: "v1",
            runId: attempt.taskRunId,
            attemptId: attempt.id,
            attemptFriendlyId: attempt.friendlyId,
            completions,
            executions,
          });
          break;
        }
        default: {
          break;
        }
      }
    });
  }
}
