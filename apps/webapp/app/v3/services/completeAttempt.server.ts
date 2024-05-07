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
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";
import { CancelAttemptService } from "./cancelAttempt.server";
import { ResumeTaskRunDependenciesService } from "./resumeTaskRunDependencies.server";
import { MAX_TASK_RUN_ATTEMPTS } from "~/consts";
import { CreateCheckpointService } from "./createCheckpoint.server";
import { TaskRun } from "@trigger.dev/database";
import { PerformTaskAttemptAlertsService } from "./alerts/performTaskAttemptAlerts.server";

type FoundAttempt = Awaited<ReturnType<typeof findAttempt>>;

type CheckpointData = {
  docker: boolean;
  location: string;
};

export class CompleteAttemptService extends BaseService {
  public async call({
    completion,
    execution,
    env,
    checkpoint,
  }: {
    completion: TaskRunExecutionResult;
    execution: TaskRunExecution;
    env?: AuthenticatedEnvironment;
    checkpoint?: CheckpointData;
  }): Promise<"COMPLETED" | "RETRIED"> {
    const taskRunAttempt = await findAttempt(this._prisma, execution.attempt.id);

    if (!taskRunAttempt) {
      logger.error("[CompleteAttemptService] Task run attempt not found", {
        id: execution.attempt.id,
      });

      // Update the task run to be failed
      await this._prisma.taskRun.update({
        where: {
          friendlyId: execution.run.id,
        },
        data: {
          status: "SYSTEM_FAILURE",
        },
      });

      return "COMPLETED";
    }

    if (completion.ok) {
      return await this.#completeAttemptSuccessfully(completion, taskRunAttempt, env);
    } else {
      return await this.#completeAttemptFailed(
        completion,
        execution,
        taskRunAttempt,
        env,
        checkpoint
      );
    }
  }

  async #completeAttemptSuccessfully(
    completion: TaskRunSuccessfulExecutionResult,
    taskRunAttempt: NonNullable<FoundAttempt>,
    env?: AuthenticatedEnvironment
  ): Promise<"COMPLETED"> {
    await this._prisma.taskRunAttempt.update({
      where: { id: taskRunAttempt.id },
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

    logger.debug("Completed attempt successfully, ACKing message");

    await marqs?.acknowledgeMessage(taskRunAttempt.taskRunId);

    // Now we need to "complete" the task run event/span
    await eventRepository.completeEvent(taskRunAttempt.taskRun.spanId, {
      endTime: new Date(),
      attributes: {
        isError: false,
        output:
          completion.outputType === "application/store" || completion.outputType === "text/plain"
            ? completion.output
            : completion.output
            ? (safeJsonParse(completion.output) as Attributes)
            : undefined,
        outputType: completion.outputType,
      },
    });

    if (!env || env.type !== "DEVELOPMENT") {
      await ResumeTaskRunDependenciesService.enqueue(taskRunAttempt.id, this._prisma);
    }

    return "COMPLETED";
  }

  async #completeAttemptFailed(
    completion: TaskRunFailedExecutionResult,
    execution: TaskRunExecution,
    taskRunAttempt: NonNullable<FoundAttempt>,
    env?: AuthenticatedEnvironment,
    checkpoint?: CheckpointData
  ): Promise<"COMPLETED" | "RETRIED"> {
    if (
      completion.error.type === "INTERNAL_ERROR" &&
      completion.error.code === "TASK_RUN_CANCELLED"
    ) {
      // We need to cancel the task run instead of fail it
      const cancelService = new CancelAttemptService();

      await cancelService.call(
        taskRunAttempt.friendlyId,
        taskRunAttempt.taskRunId,
        new Date(),
        "Cancelled by user",
        env
      );

      return "COMPLETED";
    }

    await this._prisma.taskRunAttempt.update({
      where: { id: taskRunAttempt.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        error: completion.error,
      },
    });

    const environment = env ?? (await this.#getEnvironment(execution.environment.id));

    if (environment.type !== "DEVELOPMENT") {
      await PerformTaskAttemptAlertsService.enqueue(taskRunAttempt.id, this._prisma);
    }

    if (completion.retry !== undefined && taskRunAttempt.number < MAX_TASK_RUN_ATTEMPTS) {
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
        return "RETRIED";
      }

      if (!checkpoint) {
        await this.#enqueueRetry(taskRunAttempt.taskRun, completion.retry.timestamp);
        return "RETRIED";
      }

      const createCheckpoint = new CreateCheckpointService(this._prisma);
      const checkpointCreateResult = await createCheckpoint.call({
        attemptFriendlyId: execution.attempt.id,
        docker: checkpoint.docker,
        location: checkpoint.location,
        reason: {
          type: "RETRYING_AFTER_FAILURE",
          attemptNumber: execution.attempt.number,
        },
      });

      if (!checkpointCreateResult) {
        logger.error("Failed to create checkpoint", { checkpoint, execution: execution.run.id });

        // Update the task run to be failed
        await this._prisma.taskRun.update({
          where: {
            friendlyId: execution.run.id,
          },
          data: {
            status: "SYSTEM_FAILURE",
          },
        });

        return "COMPLETED";
      }

      await this.#enqueueRetry(
        taskRunAttempt.taskRun,
        completion.retry.timestamp,
        checkpointCreateResult.event.id
      );

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

      if (
        completion.error.type === "INTERNAL_ERROR" &&
        completion.error.code === "GRACEFUL_EXIT_TIMEOUT"
      ) {
        // We need to fail all incomplete spans
        const inProgressEvents = await eventRepository.queryIncompleteEvents({
          attemptId: execution.attempt.id,
        });

        logger.debug("Failing in-progress events", {
          inProgressEvents: inProgressEvents.map((event) => event.id),
        });

        const exception = {
          type: "Graceful exit timeout",
          message: completion.error.message,
        };

        await Promise.all(
          inProgressEvents.map((event) => {
            return eventRepository.crashEvent({
              event: event,
              crashedAt: new Date(),
              exception,
            });
          })
        );

        await this._prisma.taskRun.update({
          where: {
            id: taskRunAttempt.taskRunId,
          },
          data: {
            status: "SYSTEM_FAILURE",
          },
        });
      } else {
        await this._prisma.taskRun.update({
          where: {
            id: taskRunAttempt.taskRunId,
          },
          data: {
            status: "COMPLETED_WITH_ERRORS",
          },
        });
      }

      if (!env || env.type !== "DEVELOPMENT") {
        await ResumeTaskRunDependenciesService.enqueue(taskRunAttempt.id, this._prisma);
      }

      return "COMPLETED";
    }
  }

  async #enqueueRetry(run: TaskRun, retryTimestamp: number, checkpointEventId?: string) {
    // We have to replace a potential RESUME with EXECUTE to correctly retry the attempt
    return await marqs?.replaceMessage(
      run.id,
      {
        type: "EXECUTE",
        taskIdentifier: run.taskIdentifier,
        checkpointEventId: checkpointEventId,
      },
      retryTimestamp
    );
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
