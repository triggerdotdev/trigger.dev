import { Attributes } from "@opentelemetry/api";
import {
  TaskRunContext,
  TaskRunExecution,
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  TaskRunSuccessfulExecutionResult,
  flattenAttributes,
} from "@trigger.dev/core/v3";
import { PrismaClientOrTransaction } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { safeJsonParse } from "~/utils/json";
import { eventRepository } from "../eventRepository.server";
import { marqs } from "../marqs.server";
import { BaseService } from "./baseService.server";
import { CancelAttemptService } from "./cancelAttempt.server";
import { ResumeTaskRunDependenciesService } from "./resumeTaskRunDependencies.server";
import { MAX_TASK_RUN_ATTEMPTS } from "~/consts";

type FoundAttempt = Awaited<ReturnType<typeof findAttempt>>;

export class CompleteAttemptService extends BaseService {
  public async call(
    completion: TaskRunExecutionResult,
    execution: TaskRunExecution,
    env?: AuthenticatedEnvironment
  ) {
    const taskRunAttempt = await findAttempt(this._prisma, completion.id);

    if (!taskRunAttempt) {
      logger.error("[CompleteAttemptService] Task run attempt not found", { id: completion.id });

      // Update the task run to be failed
      await this._prisma.taskRun.update({
        where: {
          friendlyId: execution.run.id,
        },
        data: {
          status: "SYSTEM_FAILURE",
        },
      });

      return "FAILED";
    }

    if (completion.ok) {
      return await this.#completeAttemptSuccessfully(completion, taskRunAttempt, env);
    } else {
      return await this.#completeAttemptFailed(completion, execution, taskRunAttempt, env);
    }
  }

  async #completeAttemptSuccessfully(
    completion: TaskRunSuccessfulExecutionResult,
    taskRunAttempt: NonNullable<FoundAttempt>,
    env?: AuthenticatedEnvironment
  ) {
    await this._prisma.taskRunAttempt.update({
      where: { friendlyId: completion.id },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        output: completion.output,
        outputType: completion.outputType,
        taskRun: {
          update: {
            data: {
              status: "COMPLETED_SUCCESSFULLY",
            },
          },
        },
      },
    });

    logger.debug("Completed attempt successfully, ACKing message", taskRunAttempt);

    await marqs?.acknowledgeMessage(taskRunAttempt.taskRunId);

    // Now we need to "complete" the task run event/span
    await eventRepository.completeEvent(taskRunAttempt.taskRun.spanId, {
      endTime: new Date(),
      attributes: {
        isError: false,
        output: completion.output ? (safeJsonParse(completion.output) as Attributes) : undefined,
      },
    });

    if (!env || env.type !== "DEVELOPMENT") {
      await ResumeTaskRunDependenciesService.enqueue(taskRunAttempt.id, this._prisma);
    }

    return "ACKNOWLEDGED";
  }

  async #completeAttemptFailed(
    completion: TaskRunFailedExecutionResult,
    execution: TaskRunExecution,
    taskRunAttempt: NonNullable<FoundAttempt>,
    env?: AuthenticatedEnvironment
  ) {
    if (
      completion.error.type === "INTERNAL_ERROR" &&
      completion.error.code === "TASK_RUN_CANCELLED"
    ) {
      // We need to cancel the task run instead of fail it
      const cancelService = new CancelAttemptService();

      return await cancelService.call(
        taskRunAttempt.friendlyId,
        taskRunAttempt.taskRunId,
        new Date(),
        "Cancelled by user",
        env
      );
    }

    await this._prisma.taskRunAttempt.update({
      where: { friendlyId: completion.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        error: completion.error,
      },
    });

    if (completion.retry !== undefined && taskRunAttempt.number < MAX_TASK_RUN_ATTEMPTS) {
      const environment = env ?? (await this.#getEnvironment(execution.environment.id));

      const retryAt = new Date(completion.retry.timestamp);

      // Retry the task run
      await eventRepository.recordEvent(`Retry #${execution.attempt.number} delay`, {
        taskSlug: taskRunAttempt.taskRun.taskIdentifier,
        environment,
        attributes: {
          metadata: this.#generateMetadataAttributesForNextAttempt(execution),
          properties: {
            retryAt: retryAt.toISOString(),
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
      });

      logger.debug("Retrying", { taskRun: taskRunAttempt.taskRun.friendlyId });

      await this._prisma.taskRun.update({
        where: {
          id: taskRunAttempt.taskRunId,
        },
        data: {
          status: "RETRYING_AFTER_FAILURE",
        },
      });

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
    } else {
      // No more retries, we need to fail the task run
      logger.debug("Completed attempt, ACKing message", taskRunAttempt);

      await marqs?.acknowledgeMessage(taskRunAttempt.taskRunId);

      // Now we need to "complete" the task run event/span
      await eventRepository.completeEvent(taskRunAttempt.taskRun.spanId, {
        endTime: new Date(),
        attributes: {
          isError: true,
        },
      });

      await this._prisma.taskRun.update({
        where: {
          id: taskRunAttempt.taskRunId,
        },
        data: {
          status: "COMPLETED_WITH_ERRORS",
        },
      });

      if (!env || env.type !== "DEVELOPMENT") {
        await ResumeTaskRunDependenciesService.enqueue(taskRunAttempt.id, this._prisma);
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

async function findAttempt(prismaClient: PrismaClientOrTransaction, friendlyId: string) {
  return prismaClient.taskRunAttempt.findUnique({
    where: { friendlyId },
    include: {
      taskRun: true,
      backgroundWorkerTask: true,
    },
  });
}
