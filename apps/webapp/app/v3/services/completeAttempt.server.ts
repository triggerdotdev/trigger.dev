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

      const environment = await this.#getEnvironment(execution.environment.id);

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

      // TODO: If this is a resumed attempt, we need to ack the RESUME and enqueue another EXECUTE (as it will no longer exist)
      await marqs?.nackMessage(taskRunAttempt.taskRunId, completion.retry.timestamp);

      return "RETRIED";
    }
    // Attempt succeeded or this was the last retry
    else {
      console.log("Completed attempt - ACK message", taskRunAttempt);

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

      if (dependency) {
        logger.debug("Completing attempt with dependency", { dependency });

        const environment = await this.#getEnvironment(taskRunAttempt.taskRun.runtimeEnvironmentId);

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

          await marqs?.acknowledgeMessage(dependentRun.id);
          await marqs?.enqueueMessage(
            environment,
            taskRunAttempt.taskRun.queue,
            dependentRun.id,
            { type: "RESUME", completedAttemptId: taskRunAttempt.id },
            taskRunAttempt.taskRun.concurrencyKey ?? undefined
          );
        } else if (dependency.dependentBatchRun) {
          const batchTaskRun = await this._prisma.batchTaskRun.findFirst({
            where: {
              id: dependency.dependentBatchRun.id,
            },
            include: {
              items: {},
            },
          });

          if (!batchTaskRun) {
            logger.error("Batch task run does not exist", {
              attemptId: taskRunAttempt.id,
              envId: taskRunAttempt.taskRun.runtimeEnvironmentId,
              batchTaskRunId: dependency.dependentBatchRunId,
            });
            return "FAILED";
          }

          if (!batchTaskRun.dependentTaskAttemptId) {
            logger.error("Dependent attempt ID shouldn't be null", {
              attemptId: taskRunAttempt.id,
              envId: taskRunAttempt.taskRun.runtimeEnvironmentId,
            });
            return "FAILED";
          }

          // FIXME: This won't work as the messageIds will be the same for every batch item completion. We should only resume once they're all done.

          await marqs?.enqueueMessage(
            environment,
            taskRunAttempt.taskRun.queue,
            // TODO: switch to task run id + set correct resume time
            batchTaskRun.dependentTaskAttemptId,
            { type: "RESUME", completedAttemptIds: taskRunAttempt.id },
            taskRunAttempt.taskRun.concurrencyKey ?? undefined
          );
        }

        logger.error("Invalid dependency", {
          attemptId: taskRunAttempt.id,
          dependencyId: dependency.id,
          envId: taskRunAttempt.taskRun.runtimeEnvironmentId,
        });

        return "FAILED";
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
