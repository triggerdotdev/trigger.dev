import {
  CoordinatorToPlatformMessages,
  InferSocketMessageSchema,
  TaskRunExecution,
  TaskRunExecutionResult,
} from "@trigger.dev/core/v3";
import { $transaction, PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { marqs } from "../marqs.server";
import { socketIo } from "../handleSocketIo.server";
import { sharedQueueTasks } from "../marqs/sharedQueueConsumer.server";

export class ResumeAttemptService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    params: InferSocketMessageSchema<typeof CoordinatorToPlatformMessages, "READY_FOR_RESUME">
  ): Promise<void> {
    logger.debug(`ResumeAttemptService.call()`, params);

    await $transaction(this.#prismaClient, async (tx) => {
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
          // Nothing to do, but thanks for checking in!
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
            const completedAttempt = await prisma.taskRunAttempt.findUnique({
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

          await prisma.taskRunAttempt.update({
            where: {
              id: attempt.id,
            },
            data: {
              status: "EXECUTING",
              taskRun: {
                update: {
                  data: {
                    status: "EXECUTING",
                  },
                },
              },
            },
          });

          socketIo.coordinatorNamespace.emit("RESUME", {
            version: "v1",
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
