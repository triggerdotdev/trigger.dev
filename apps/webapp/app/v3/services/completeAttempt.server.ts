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

export class CompleteAttemptService extends BaseService {
  public async call(
    completion: TaskRunExecutionResult,
    execution: TaskRunExecution,
    env: AuthenticatedEnvironment
  ): Promise<"ACKNOWLEDGED" | "RETRIED"> {
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
            taskRun: true,
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
            taskRun: true,
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

      const retryAt = new Date(completion.retry.timestamp);
      // Retry the task run
      await eventRepository.recordEvent(
        retryConfig?.maxAttempts
          ? `Retry ${execution.attempt.number}/${retryConfig?.maxAttempts - 1} delay`
          : `Retry #${execution.attempt.number} delay`,
        {
          taskSlug: taskRunAttempt.taskRun.taskIdentifier,
          environment: env,
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

      await marqs?.nackMessage(taskRunAttempt.taskRunId, completion.retry.timestamp);

      return "RETRIED";
    } else {
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
}
