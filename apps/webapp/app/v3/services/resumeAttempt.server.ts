import {
  CoordinatorToPlatformMessages,
  InferSocketMessageSchema,
  TaskRunExecution,
  TaskRunExecutionResult,
} from "@trigger.dev/core/v3";
import { PrismaClient, prisma } from "~/db.server";
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

    const attempt = await this.#prismaClient.taskRunAttempt.findUnique({
      where: {
        id: params.attemptId,
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
      logger.error("Could not find attempt", { attemptId: params.attemptId });
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
            logger.error("No dependent attempt", { attemptId: params.attemptId });
            return;
          }

          completedAttemptIds = [dependentAttempt.id];
        } else if (attempt.batchTaskRunDependency) {
          const dependentBatchItems = attempt.batchTaskRunDependency.items;

          if (!dependentBatchItems) {
            logger.error("No dependent batch items", { attemptId: params.attemptId });
            return;
          }

          completedAttemptIds = dependentBatchItems.map((item) => item.taskRun.attempts[0]?.id);
        } else {
          logger.error("No dependencies", { attemptId: params.attemptId });
          return;
        }

        if (completedAttemptIds.length === 0) {
          logger.error("No completed attempt IDs", { attemptId: params.attemptId });
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
              attemptId: params.attemptId,
              completedAttemptId,
            });
            await marqs?.acknowledgeMessage(attempt.taskRunId);
            return;
          }

          const completion = await sharedQueueTasks.getCompletionPayloadFromAttempt(
            completedAttempt.id
          );

          if (!completion) {
            await marqs?.acknowledgeMessage(attempt.taskRunId);
            return;
          }

          completions.push(completion);

          const executionPayload = await sharedQueueTasks.getExecutionPayloadFromAttempt(
            completedAttempt.id,
            false
          );

          if (!executionPayload) {
            await marqs?.acknowledgeMessage(attempt.taskRunId);
            return;
          }

          executions.push(executionPayload.execution);
        }

        socketIo.coordinatorNamespace.emit("RESUME", {
          version: "v1",
          attemptId: params.attemptId,
          completions,
          executions,
        });
        break;
      }
      default: {
        break;
      }
    }
  }
}
