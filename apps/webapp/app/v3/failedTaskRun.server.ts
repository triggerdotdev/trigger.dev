import {
  calculateNextRetryDelay,
  RetryOptions,
  sanitizeError,
  TaskRunExecution,
  TaskRunExecutionRetry,
  TaskRunFailedExecutionResult,
} from "@trigger.dev/core/v3";
import { logger } from "~/services/logger.server";
import { createExceptionPropertiesFromError, eventRepository } from "./eventRepository.server";
import { BaseService } from "./services/baseService.server";
import { FinalizeTaskRunService } from "./services/finalizeTaskRun.server";
import { isFailableRunStatus, isFinalAttemptStatus } from "./taskStatus";
import { Prisma } from "@trigger.dev/database";
import { CompleteAttemptService } from "./services/completeAttempt.server";
import { CreateTaskRunAttemptService } from "./services/createTaskRunAttempt.server";
import { sharedQueueTasks } from "./marqs/sharedQueueConsumer.server";

const includeAttempts = {
  attempts: {
    orderBy: {
      createdAt: "desc",
    },
    take: 1,
  },
  lockedBy: true,
} satisfies Prisma.TaskRunInclude;

type TaskRunWithAttempts = Prisma.TaskRunGetPayload<{
  include: typeof includeAttempts;
}>;

export class FailedTaskRunService extends BaseService {
  public async call(anyRunId: string, completion: TaskRunFailedExecutionResult) {
    logger.debug("[FailedTaskRunService] Handling failed task run", { anyRunId, completion });

    const isFriendlyId = anyRunId.startsWith("run_");

    const taskRun = await this._prisma.taskRun.findUnique({
      where: {
        friendlyId: isFriendlyId ? anyRunId : undefined,
        id: !isFriendlyId ? anyRunId : undefined,
      },
      include: includeAttempts,
    });

    if (!taskRun) {
      logger.error("[FailedTaskRunService] Task run not found", {
        anyRunId,
        completion,
      });

      return;
    }

    if (!isFailableRunStatus(taskRun.status)) {
      logger.error("[FailedTaskRunService] Task run is not in a failable state", {
        taskRun,
        completion,
      });

      return;
    }

    const retriableExecution = await this.#getRetriableAttemptExecution(taskRun, completion);

    if (retriableExecution) {
      logger.debug("[FailedTaskRunService] Completing attempt", { taskRun, completion });

      const executionRetry =
        completion.retry ?? (await this.#getExecutionRetry(taskRun, retriableExecution));

      const completeAttempt = new CompleteAttemptService(this._prisma);
      await completeAttempt.call({
        completion: {
          ...completion,
          retry: executionRetry,
        },
        execution: retriableExecution,
        isSystemFailure: true,
      });

      return;
    }

    // No retriable execution, so we need to fail the task run
    logger.debug("[FailedTaskRunService] Failing task run", { taskRun, completion });

    const finalizeService = new FinalizeTaskRunService();
    await finalizeService.call({
      id: taskRun.id,
      status: "SYSTEM_FAILURE",
      completedAt: new Date(),
      attemptStatus: "FAILED",
      error: sanitizeError(completion.error),
    });

    // Now we need to "complete" the task run event/span
    await eventRepository.completeEvent(taskRun.spanId, {
      endTime: new Date(),
      attributes: {
        isError: true,
      },
      events: [
        {
          name: "exception",
          time: new Date(),
          properties: {
            exception: createExceptionPropertiesFromError(completion.error),
          },
        },
      ],
    });
  }

  async #getRetriableAttemptExecution(
    run: TaskRunWithAttempts,
    completion: TaskRunFailedExecutionResult
  ): Promise<TaskRunExecution | undefined> {
    let attempt = run.attempts[0];

    // We need to create an attempt if:
    // - None exists yet
    // - The last attempt has a final status, e.g. we failed between attempts
    if (!attempt || isFinalAttemptStatus(attempt.status)) {
      logger.error("[FailedTaskRunService] No attempts found", {
        run,
        completion,
      });

      const createAttempt = new CreateTaskRunAttemptService(this._prisma);

      try {
        const { execution } = await createAttempt.call(run.id);
        return execution;
      } catch (error) {
        logger.error("[FailedTaskRunService] Failed to create attempt", {
          run,
          completion,
          error,
        });

        return;
      }
    }

    // We already have an attempt with non-final status, let's use it
    try {
      const executionPayload = await sharedQueueTasks.getExecutionPayloadFromAttempt(
        attempt.id,
        undefined,
        undefined,
        true
      );
      return executionPayload?.execution;
    } catch (error) {
      logger.error("[FailedTaskRunService] Failed to get execution payload", {
        run,
        completion,
        error,
      });

      return;
    }
  }

  async #getExecutionRetry(
    run: TaskRunWithAttempts,
    execution: TaskRunExecution
  ): Promise<TaskRunExecutionRetry | undefined> {
    const parsedRetryConfig = RetryOptions.safeParse(run.lockedBy?.retryConfig);

    if (!parsedRetryConfig.success) {
      logger.error("[FailedTaskRunService] Invalid retry config", {
        run,
        execution,
      });

      return;
    }

    const delay = calculateNextRetryDelay(parsedRetryConfig.data, execution.attempt.number);

    if (!delay) {
      logger.debug("[FailedTaskRunService] No more retries", {
        run,
        execution,
      });

      return;
    }

    return {
      timestamp: Date.now() + delay,
      delay,
    };
  }
}
