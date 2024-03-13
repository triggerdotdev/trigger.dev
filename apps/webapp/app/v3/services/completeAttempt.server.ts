import {
  RetryOptions,
  TaskRunContext,
  TaskRunExecution,
  TaskRunExecutionResult,
  defaultRetryOptions,
  flattenAttributes,
} from "@trigger.dev/core/v3";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { eventRepository } from "../eventRepository.server";
import { marqs } from "../marqs.server";
import { BaseService } from "./baseService.server";
import { Attributes } from "@opentelemetry/api";
import { logger } from "~/services/logger.server";

export class CompleteAttemptService extends BaseService {
  public async call(
    completion: TaskRunExecutionResult,
    execution: TaskRunExecution,
    env?: AuthenticatedEnvironment
  ): Promise<"ACKNOWLEDGED" | "RETRIED" | "FAILED"> {
    const taskRunAttempt = completion.ok
      ? await this._prisma.taskRunAttempt.update({
          where: { friendlyId: completion.id },
          data: {
            status: "COMPLETED",
            completedAt: new Date(),
            output: completion.output,
            outputType: completion.outputType,
          },
          include: {
            taskRun: {
              include: {
                batchItem: true,
                dependency: {
                  include: {
                    dependentAttempt: true,
                    dependentBatchRun: true,
                  },
                },
              },
            },
            backgroundWorkerTask: true,
          },
        })
      : await this._prisma.taskRunAttempt.update({
          where: { friendlyId: completion.id },
          data: {
            status: "FAILED",
            completedAt: new Date(),
            error: completion.error,
          },
          include: {
            taskRun: {
              include: {
                batchItem: true,
                dependency: {
                  include: {
                    dependentAttempt: true,
                    dependentBatchRun: true,
                  },
                },
              },
            },
            backgroundWorkerTask: true,
          },
        });

    if (!completion.ok && completion.retry !== undefined) {
      const retryConfig = taskRunAttempt.backgroundWorkerTask.retryConfig
        ? {
            ...defaultRetryOptions,
            ...RetryOptions.parse(taskRunAttempt.backgroundWorkerTask.retryConfig),
          }
        : undefined;

      const environment = env ?? (await this.#getEnvironment(execution.environment.id));

      const retryAt = new Date(completion.retry.timestamp);

      // Retry the task run
      await eventRepository.recordEvent(
        retryConfig?.maxAttempts
          ? `Retry ${execution.attempt.number}/${retryConfig?.maxAttempts - 1} delay`
          : `Retry #${execution.attempt.number} delay`,
        {
          taskSlug: taskRunAttempt.taskRun.taskIdentifier,
          environment,
          attributes: {
            metadata: this.#generateMetadataAttributesForNextAttempt(execution),
            properties: {
              retryAt: retryAt.toISOString(),
              factor: retryConfig?.factor,
              maxAttempts: retryConfig?.maxAttempts,
              minTimeoutInMs: retryConfig?.minTimeoutInMs,
              maxTimeoutInMs: retryConfig?.maxTimeoutInMs,
              randomize: retryConfig?.randomize,
            },
            runId: taskRunAttempt.taskRunId,
            style: {
              icon: "schedule-attempt",
            },
            queueId: taskRunAttempt.queueId,
            queueName: taskRunAttempt.taskRun.queue,
          },
          context: taskRunAttempt.taskRun.traceContext as Record<string, string | undefined>,
          spanIdSeed: `retry-${taskRunAttempt.number + 1}`,
          endTime: retryAt,
        }
      );

      logger.debug("Retrying", { taskRun: taskRunAttempt.taskRun.friendlyId });

      if (environment.type === "DEVELOPMENT") {
        // This is already an EXECUTE message so we can just NACK
        await marqs?.nackMessage(taskRunAttempt.taskRunId, completion.retry.timestamp);
      } else {
        // We have to replace a potential RESUME with EXECUTE to correctly retry the attempt
        await marqs?.replaceMessage(
          taskRunAttempt.taskRunId,
          {
            type: "EXECUTE",
            taskIdentifier: taskRunAttempt.taskRun.taskIdentifier,
          },
          completion.retry.timestamp
        );
      }

      return "RETRIED";
    }
    // Attempt succeeded or this was the last retry
    else {
      logger.debug("Completed attempt, ACKing message", taskRunAttempt);

      await marqs?.acknowledgeMessage(taskRunAttempt.taskRunId);

      // Now we need to "complete" the task run event/span
      if (completion.ok) {
        await eventRepository.completeEvent(taskRunAttempt.taskRun.spanId, {
          endTime: new Date(),
          attributes: {
            isError: false,
            output: completion.output ? (JSON.parse(completion.output) as Attributes) : undefined,
          },
        });
      } else {
        await eventRepository.completeEvent(taskRunAttempt.taskRun.spanId, {
          endTime: new Date(),
          attributes: {
            isError: true,
          },
        });
      }

      const { batchItem, dependency } = taskRunAttempt.taskRun;

      // This run is part of a batch so we should update its status
      if (batchItem) {
        logger.debug("Completing attempt with batch item", { batchItem });

        await this._prisma.batchTaskRunItem.update({
          where: {
            id: batchItem.id,
          },
          data: {
            status: completion.ok ? "COMPLETED" : "FAILED",
          },
        });

        const finalizedBatchRun = await this._prisma.batchTaskRun.findFirst({
          where: {
            id: batchItem.batchTaskRunId,
            dependentTaskAttemptId: {
              not: null,
            },
            items: {
              every: {
                status: {
                  not: "PENDING",
                },
              },
            },
          },
          include: {
            dependentTaskAttempt: {
              include: {
                taskRun: true,
              },
            },
            items: {
              include: {
                taskRun: {
                  include: {
                    attempts: {
                      orderBy: {
                        completedAt: "desc",
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
        });

        // This batch has a dependent attempt and just finalized, we should resume that attempt
        if (finalizedBatchRun && finalizedBatchRun.dependentTaskAttempt) {
          const environment =
            env ?? (await this.#getEnvironment(taskRunAttempt.taskRun.runtimeEnvironmentId));

          if (!environment) {
            logger.error("Environment not found", {
              attemptId: taskRunAttempt.id,
              envId: taskRunAttempt.taskRun.runtimeEnvironmentId,
            });
            return "FAILED";
          }

          if (environment.type === "DEVELOPMENT") {
            return "ACKNOWLEDGED";
          }

          const dependentRun = finalizedBatchRun.dependentTaskAttempt.taskRun;

          if (finalizedBatchRun.dependentTaskAttempt.status === "PAUSED") {
            await marqs?.enqueueMessage(
              environment,
              dependentRun.queue,
              dependentRun.id,
              {
                type: "RESUME",
                completedAttemptIds: [taskRunAttempt.id],
              },
              dependentRun.concurrencyKey ?? undefined
            );
          } else {
            await marqs?.replaceMessage(dependentRun.id, {
              type: "RESUME",
              completedAttemptIds: finalizedBatchRun.items.map(
                (item) => item.taskRun.attempts[0]?.id
              ),
            });
          }
        }
      }

      if (dependency) {
        logger.debug("Completing attempt with dependency", { dependency });

        const environment =
          env ?? (await this.#getEnvironment(taskRunAttempt.taskRun.runtimeEnvironmentId));

        if (!environment) {
          logger.error("Environment not found", {
            attemptId: taskRunAttempt.id,
            envId: taskRunAttempt.taskRun.runtimeEnvironmentId,
          });
          return "FAILED";
        }

        if (environment.type === "DEVELOPMENT") {
          return "ACKNOWLEDGED";
        }

        if (dependency.dependentAttempt) {
          const dependentRun = await this._prisma.taskRun.findFirst({
            where: {
              id: dependency.dependentAttempt.taskRunId,
            },
          });

          if (!dependentRun) {
            logger.error("Dependent task run does not exist", {
              attemptId: taskRunAttempt.id,
              envId: taskRunAttempt.taskRun.runtimeEnvironmentId,
              taskRunId: dependency.taskRunId,
            });
            return "FAILED";
          }

          if (dependency.dependentAttempt.status === "PAUSED") {
            await marqs?.enqueueMessage(
              environment,
              dependentRun.queue,
              dependentRun.id,
              {
                type: "RESUME",
                completedAttemptIds: [taskRunAttempt.id],
              },
              dependentRun.concurrencyKey ?? undefined
            );
          } else {
            await marqs?.replaceMessage(dependentRun.id, {
              type: "RESUME",
              completedAttemptIds: [taskRunAttempt.id],
            });
          }
        }
      }

      return "ACKNOWLEDGED";
    }
  }

  #generateMetadataAttributesForNextAttempt(execution: TaskRunExecution) {
    const context = TaskRunContext.parse(execution);

    // @ts-ignore
    context.attempt = {
      number: context.attempt.number + 1,
    };

    return flattenAttributes(context, "ctx");
  }

  async #getEnvironment(id: string) {
    return await this._prisma.runtimeEnvironment.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        project: true,
        organization: true,
      },
    });
  }
}
