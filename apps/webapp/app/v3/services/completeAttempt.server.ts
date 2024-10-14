import { Attributes } from "@opentelemetry/api";
import {
  TaskRunContext,
  TaskRunExecution,
  TaskRunExecutionResult,
  TaskRunExecutionRetry,
  TaskRunFailedExecutionResult,
  TaskRunSuccessfulExecutionResult,
  flattenAttributes,
  sanitizeError,
} from "@trigger.dev/core/v3";
import { $transaction, PrismaClientOrTransaction } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { safeJsonParse } from "~/utils/json";
import { createExceptionPropertiesFromError, eventRepository } from "../eventRepository.server";
import { marqs } from "~/v3/marqs/index.server";
import { BaseService } from "./baseService.server";
import { CancelAttemptService } from "./cancelAttempt.server";
import { MAX_TASK_RUN_ATTEMPTS } from "~/consts";
import { CreateCheckpointService } from "./createCheckpoint.server";
import { TaskRun } from "@trigger.dev/database";
import { RetryAttemptService } from "./retryAttempt.server";
import { isFinalAttemptStatus, isFinalRunStatus } from "../taskStatus";
import { FinalizeTaskRunService } from "./finalizeTaskRun.server";
import { env } from "~/env.server";

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
    supportsRetryCheckpoints,
  }: {
    completion: TaskRunExecutionResult;
    execution: TaskRunExecution;
    env?: AuthenticatedEnvironment;
    checkpoint?: CheckpointData;
    supportsRetryCheckpoints?: boolean;
  }): Promise<"COMPLETED" | "RETRIED"> {
    const taskRunAttempt = await findAttempt(this._prisma, execution.attempt.id);

    if (!taskRunAttempt) {
      logger.error("[CompleteAttemptService] Task run attempt not found", {
        id: execution.attempt.id,
      });

      const run = await this._prisma.taskRun.findFirst({
        where: {
          friendlyId: execution.run.id,
        },
        select: {
          id: true,
        },
      });

      if (!run) {
        logger.error("[CompleteAttemptService] Task run not found", {
          friendlyId: execution.run.id,
        });

        return "COMPLETED";
      }

      const finalizeService = new FinalizeTaskRunService();
      await finalizeService.call({
        id: run.id,
        status: "SYSTEM_FAILURE",
        completedAt: new Date(),
        attemptStatus: "FAILED",
        error: {
          type: "INTERNAL_ERROR",
          code: "TASK_EXECUTION_FAILED",
          message: "Tried to complete attempt but it doesn't exist",
        },
      });

      // No attempt, so there's no message to ACK
      return "COMPLETED";
    }

    if (
      isFinalAttemptStatus(taskRunAttempt.status) ||
      isFinalRunStatus(taskRunAttempt.taskRun.status)
    ) {
      // We don't want to retry a task run that has already been marked as failed, cancelled, or completed
      logger.debug("[CompleteAttemptService] Attempt or run is already in a final state", {
        taskRunAttempt,
        completion,
      });

      return "COMPLETED";
    }

    if (completion.ok) {
      return await this.#completeAttemptSuccessfully(completion, taskRunAttempt, env);
    } else {
      return await this.#completeAttemptFailed({
        completion,
        execution,
        taskRunAttempt,
        env,
        checkpoint,
        supportsRetryCheckpoints,
      });
    }
  }

  async #completeAttemptSuccessfully(
    completion: TaskRunSuccessfulExecutionResult,
    taskRunAttempt: NonNullable<FoundAttempt>,
    env?: AuthenticatedEnvironment
  ): Promise<"COMPLETED"> {
    await $transaction(this._prisma, async (tx) => {
      await tx.taskRunAttempt.update({
        where: { id: taskRunAttempt.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          output: completion.output,
          outputType: completion.outputType,
          usageDurationMs: completion.usage?.durationMs,
          taskRun: {
            update: {
              output: completion.output,
              outputType: completion.outputType,
            },
          },
        },
      });

      const finalizeService = new FinalizeTaskRunService(tx);
      await finalizeService.call({
        id: taskRunAttempt.taskRunId,
        status: "COMPLETED_SUCCESSFULLY",
        completedAt: new Date(),
      });
    });

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

    return "COMPLETED";
  }

  async #completeAttemptFailed({
    completion,
    execution,
    taskRunAttempt,
    env,
    checkpoint,
    supportsRetryCheckpoints,
  }: {
    completion: TaskRunFailedExecutionResult;
    execution: TaskRunExecution;
    taskRunAttempt: NonNullable<FoundAttempt>;
    env?: AuthenticatedEnvironment;
    checkpoint?: CheckpointData;
    supportsRetryCheckpoints?: boolean;
  }): Promise<"COMPLETED" | "RETRIED"> {
    if (
      completion.error.type === "INTERNAL_ERROR" &&
      completion.error.code === "TASK_RUN_CANCELLED"
    ) {
      // We need to cancel the task run instead of fail it
      const cancelService = new CancelAttemptService();

      // TODO: handle usages
      await cancelService.call(
        taskRunAttempt.friendlyId,
        taskRunAttempt.taskRunId,
        new Date(),
        "Cancelled by user",
        env
      );

      return "COMPLETED";
    }

    const sanitizedError = sanitizeError(completion.error);

    // TODO: make this handle the case where the current attempt is unknown, with only a run id

    // 1. Get the task run

    // 2. Get the most recent attempt

    // 3. Get the retry config

    await this._prisma.taskRunAttempt.update({
      where: { id: taskRunAttempt.id },
      data: {
        status: "FAILED",
        completedAt: new Date(),
        error: sanitizedError,
        usageDurationMs: completion.usage?.durationMs,
      },
    });

    const environment = env ?? (await this.#getEnvironment(execution.environment.id));

    if (completion.retry !== undefined && taskRunAttempt.number < MAX_TASK_RUN_ATTEMPTS) {
      return await this.#retryAttempt({
        execution,
        executionRetry: completion.retry,
        taskRunAttempt,
        environment,
        checkpoint,
        supportsRetryCheckpoints,
      });
    }

    // The attempt has failed and we won't retry

    // Now we need to "complete" the task run event/span
    await eventRepository.completeEvent(taskRunAttempt.taskRun.spanId, {
      endTime: new Date(),
      attributes: {
        isError: true,
      },
      events: [
        {
          name: "exception",
          time: new Date(),
          properties: {
            exception: createExceptionPropertiesFromError(sanitizedError),
          },
        },
      ],
    });

    await this._prisma.taskRun.update({
      where: {
        id: taskRunAttempt.taskRunId,
      },
      data: {
        error: sanitizedError,
      },
    });

    const status =
      sanitizedError.type === "INTERNAL_ERROR" && sanitizedError.code === "MAX_DURATION_EXCEEDED"
        ? "TIMED_OUT"
        : "COMPLETED_WITH_ERRORS";

    const finalizeService = new FinalizeTaskRunService();
    await finalizeService.call({
      id: taskRunAttempt.taskRunId,
      status,
      completedAt: new Date(),
    });

    return "COMPLETED";
  }

  async #enqueueReattempt({
    run,
    executionRetry,
    checkpointEventId,
    supportsLazyAttempts,
    supportsRetryCheckpoints,
  }: {
    run: TaskRun;
    executionRetry: TaskRunExecutionRetry;
    checkpointEventId?: string;
    supportsLazyAttempts: boolean;
    supportsRetryCheckpoints?: boolean;
  }) {
    const retryViaQueue = () => {
      // We have to replace a potential RESUME with EXECUTE to correctly retry the attempt
      return marqs?.replaceMessage(
        run.id,
        {
          type: "EXECUTE",
          taskIdentifier: run.taskIdentifier,
          checkpointEventId: supportsRetryCheckpoints ? checkpointEventId : undefined,
          retryCheckpointsDisabled: !supportsRetryCheckpoints,
        },
        executionRetry.timestamp
      );
    };

    const retryDirectly = () => {
      return RetryAttemptService.enqueue(run.id, this._prisma, new Date(executionRetry.timestamp));
    };

    // There's a checkpoint, so we need to go through the queue
    if (checkpointEventId) {
      if (!supportsRetryCheckpoints) {
        logger.error("Worker does not support retry checkpoints, but a checkpoint was created", {
          runId: run.id,
          checkpointEventId,
        });
      }

      await retryViaQueue();
      return;
    }

    // Workers without lazy attempt support always need to go through the queue, which is where the attempt is created
    if (!supportsLazyAttempts) {
      await retryViaQueue();
      return;
    }

    // Workers that never checkpoint between attempts will exit after completing their current attempt if the retry delay exceeds the threshold
    if (!supportsRetryCheckpoints && executionRetry.delay >= env.CHECKPOINT_THRESHOLD_IN_MS) {
      await retryViaQueue();
      return;
    }

    // The worker is still running and waiting for a retry message
    await retryDirectly();
  }

  async #retryAttempt({
    execution,
    executionRetry,
    taskRunAttempt,
    environment,
    checkpoint,
    supportsRetryCheckpoints,
  }: {
    execution: TaskRunExecution;
    executionRetry: TaskRunExecutionRetry;
    taskRunAttempt: NonNullable<FoundAttempt>;
    environment: AuthenticatedEnvironment;
    checkpoint?: CheckpointData;
    supportsRetryCheckpoints?: boolean;
  }) {
    const retryAt = new Date(executionRetry.timestamp);

    // Retry the task run
    await eventRepository.recordEvent(`Retry #${execution.attempt.number} delay`, {
      taskSlug: taskRunAttempt.taskRun.taskIdentifier,
      environment,
      attributes: {
        metadata: this.#generateMetadataAttributesForNextAttempt(execution),
        properties: {
          retryAt: retryAt.toISOString(),
        },
        runId: taskRunAttempt.taskRun.friendlyId,
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

    logger.debug("Retrying", {
      taskRun: taskRunAttempt.taskRun.friendlyId,
      retry: executionRetry,
    });

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
      await marqs?.nackMessage(taskRunAttempt.taskRunId, executionRetry.timestamp);
      return "RETRIED";
    }

    if (checkpoint) {
      // This is only here for backwards compat - we don't checkpoint between attempts anymore
      return await this.#retryAttemptWithCheckpoint({
        execution,
        taskRunAttempt,
        executionRetry,
        checkpoint,
        supportsRetryCheckpoints,
      });
    }

    await this.#enqueueReattempt({
      run: taskRunAttempt.taskRun,
      executionRetry,
      supportsLazyAttempts: taskRunAttempt.backgroundWorker.supportsLazyAttempts,
      supportsRetryCheckpoints,
    });

    return "RETRIED";
  }

  async #retryAttemptWithCheckpoint({
    execution,
    taskRunAttempt,
    executionRetry,
    checkpoint,
    supportsRetryCheckpoints,
  }: {
    execution: TaskRunExecution;
    taskRunAttempt: NonNullable<FoundAttempt>;
    executionRetry: TaskRunExecutionRetry;
    checkpoint: CheckpointData;
    supportsRetryCheckpoints?: boolean;
  }) {
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

    if (!checkpointCreateResult.success) {
      logger.error("Failed to create reattempt checkpoint", {
        checkpoint,
        runId: execution.run.id,
        attemptId: execution.attempt.id,
      });

      const finalizeService = new FinalizeTaskRunService();
      await finalizeService.call({
        id: taskRunAttempt.taskRunId,
        status: "SYSTEM_FAILURE",
        completedAt: new Date(),
        error: {
          type: "STRING_ERROR",
          raw: "Failed to create reattempt checkpoint",
        },
      });

      return "COMPLETED" as const;
    }

    await this.#enqueueReattempt({
      run: taskRunAttempt.taskRun,
      executionRetry,
      checkpointEventId: checkpointCreateResult.event.id,
      supportsLazyAttempts: taskRunAttempt.backgroundWorker.supportsLazyAttempts,
      supportsRetryCheckpoints,
    });

    return "RETRIED" as const;
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
      backgroundWorker: {
        select: {
          id: true,
          supportsLazyAttempts: true,
        },
      },
    },
  });
}
