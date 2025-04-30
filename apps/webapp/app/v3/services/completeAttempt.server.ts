import { Attributes } from "@opentelemetry/api";
import {
  MachinePresetName,
  TaskRunContext,
  TaskRunError,
  TaskRunErrorCodes,
  TaskRunExecution,
  TaskRunExecutionResult,
  TaskRunExecutionRetry,
  TaskRunFailedExecutionResult,
  TaskRunSuccessfulExecutionResult,
  flattenAttributes,
  isOOMRunError,
  sanitizeError,
  shouldRetryError,
  taskRunErrorEnhancer,
} from "@trigger.dev/core/v3";
import { TaskRun } from "@trigger.dev/database";
import { MAX_TASK_RUN_ATTEMPTS } from "~/consts";
import { PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { emitRunRetryScheduled } from "~/services/runsDashboardInstance.server";
import { safeJsonParse } from "~/utils/json";
import { marqs } from "~/v3/marqs/index.server";
import { createExceptionPropertiesFromError, eventRepository } from "../eventRepository.server";
import { FailedTaskRunRetryHelper } from "../failedTaskRun.server";
import { socketIo } from "../handleSocketIo.server";
import { getTaskEventStoreTableForRun } from "../taskEventStore.server";
import { FAILED_RUN_STATUSES, isFinalAttemptStatus, isFinalRunStatus } from "../taskStatus";
import { BaseService } from "./baseService.server";
import { CancelAttemptService } from "./cancelAttempt.server";
import { CreateCheckpointService } from "./createCheckpoint.server";
import { FinalizeTaskRunService } from "./finalizeTaskRun.server";
import { RetryAttemptService } from "./retryAttempt.server";

type FoundAttempt = Awaited<ReturnType<typeof findAttempt>>;

type CheckpointData = {
  docker: boolean;
  location: string;
};

type CompleteAttemptServiceOptions = {
  prisma?: PrismaClientOrTransaction;
  supportsRetryCheckpoints?: boolean;
  isSystemFailure?: boolean;
  isCrash?: boolean;
};

export class CompleteAttemptService extends BaseService {
  constructor(private opts: CompleteAttemptServiceOptions = {}) {
    super(opts.prisma);
  }

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
          code: TaskRunErrorCodes.TASK_EXECUTION_FAILED,
          message: "Tried to complete attempt but it doesn't exist",
        },
        metadata: completion.metadata,
        env,
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
      });
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
        usageDurationMs: completion.usage?.durationMs,
        taskRun: {
          update: {
            output: completion.output,
            outputType: completion.outputType,
          },
        },
      },
    });

    const finalizeService = new FinalizeTaskRunService();
    await finalizeService.call({
      id: taskRunAttempt.taskRunId,
      status: "COMPLETED_SUCCESSFULLY",
      completedAt: new Date(),
      metadata: completion.metadata,
      env,
    });

    // Now we need to "complete" the task run event/span
    await eventRepository.completeEvent(
      getTaskEventStoreTableForRun(taskRunAttempt.taskRun),
      taskRunAttempt.taskRun.spanId,
      taskRunAttempt.taskRun.createdAt,
      taskRunAttempt.taskRun.completedAt ?? undefined,
      {
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
      }
    );

    return "COMPLETED";
  }

  async #completeAttemptFailed({
    completion,
    execution,
    taskRunAttempt,
    env,
    checkpoint,
  }: {
    completion: TaskRunFailedExecutionResult;
    execution: TaskRunExecution;
    taskRunAttempt: NonNullable<FoundAttempt>;
    env?: AuthenticatedEnvironment;
    checkpoint?: CheckpointData;
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

    const failedAt = new Date();
    const sanitizedError = sanitizeError(completion.error);

    await this._prisma.taskRunAttempt.update({
      where: { id: taskRunAttempt.id },
      data: {
        status: "FAILED",
        completedAt: failedAt,
        error: sanitizedError,
        usageDurationMs: completion.usage?.durationMs,
      },
    });

    const environment = env ?? (await this.#getEnvironment(execution.environment.id));

    // This means that tasks won't know they are being retried
    let executionRetryInferred = false;
    let executionRetry = completion.retry;

    const shouldInfer = this.opts.isCrash || this.opts.isSystemFailure;

    if (!executionRetry && shouldInfer) {
      executionRetryInferred = true;
      executionRetry = FailedTaskRunRetryHelper.getExecutionRetry({
        run: {
          ...taskRunAttempt.taskRun,
          lockedBy: taskRunAttempt.backgroundWorkerTask,
          lockedToVersion: taskRunAttempt.backgroundWorker,
        },
        execution,
      });
    }

    let retriableError = shouldRetryError(taskRunErrorEnhancer(completion.error));
    let isOOMRetry = false;
    let isOOMAttempt = isOOMRunError(completion.error);
    let isOnMaxOOMMachine = false;
    let oomMachine: MachinePresetName | undefined;

    //OOM errors should retry (if an OOM machine is specified, and we're not already on it)
    if (isOOMAttempt) {
      const retryConfig = FailedTaskRunRetryHelper.getRetryConfig({
        run: {
          ...taskRunAttempt.taskRun,
          lockedBy: taskRunAttempt.backgroundWorkerTask,
          lockedToVersion: taskRunAttempt.backgroundWorker,
        },
        execution,
      });

      oomMachine = retryConfig?.outOfMemory?.machine;
      isOnMaxOOMMachine = oomMachine === taskRunAttempt.taskRun.machinePreset;

      if (oomMachine && !isOnMaxOOMMachine) {
        //we will retry
        isOOMRetry = true;
        retriableError = true;
        executionRetry = FailedTaskRunRetryHelper.getExecutionRetry({
          run: {
            ...taskRunAttempt.taskRun,
            lockedBy: taskRunAttempt.backgroundWorkerTask,
            lockedToVersion: taskRunAttempt.backgroundWorker,
          },
          execution,
        });

        //update the machine on the run
        await this._prisma.taskRun.update({
          where: {
            id: taskRunAttempt.taskRunId,
          },
          data: {
            machinePreset: oomMachine,
          },
        });
      }
    }

    if (
      retriableError &&
      executionRetry !== undefined &&
      taskRunAttempt.number < MAX_TASK_RUN_ATTEMPTS
    ) {
      return await this.#retryAttempt({
        execution,
        executionRetry,
        executionRetryInferred,
        taskRunAttempt,
        environment,
        checkpoint,
        forceRequeue: isOOMRetry,
        oomMachine,
        error: sanitizedError,
      });
    }

    // The attempt has failed and we won't retry

    if (isOOMAttempt && isOnMaxOOMMachine && environment.type !== "DEVELOPMENT") {
      // The attempt failed due to an OOM error but we're already on the machine we should retry on
      exitRun(taskRunAttempt.taskRunId);
    }

    // Now we need to "complete" the task run event/span
    await eventRepository.completeEvent(
      getTaskEventStoreTableForRun(taskRunAttempt.taskRun),
      taskRunAttempt.taskRun.spanId,
      taskRunAttempt.taskRun.createdAt,
      taskRunAttempt.taskRun.completedAt ?? undefined,
      {
        endTime: failedAt,
        attributes: {
          isError: true,
        },
        events: [
          {
            name: "exception",
            time: failedAt,
            properties: {
              exception: createExceptionPropertiesFromError(sanitizedError),
            },
          },
        ],
      }
    );

    await this._prisma.taskRun.update({
      where: {
        id: taskRunAttempt.taskRunId,
      },
      data: {
        error: sanitizedError,
      },
    });

    let status: FAILED_RUN_STATUSES;

    // Set the correct task run status
    if (this.opts.isSystemFailure) {
      status = "SYSTEM_FAILURE";
    } else if (this.opts.isCrash) {
      status = "CRASHED";
    } else if (
      sanitizedError.type === "INTERNAL_ERROR" &&
      sanitizedError.code === "MAX_DURATION_EXCEEDED"
    ) {
      status = "TIMED_OUT";
    } else if (sanitizedError.type === "INTERNAL_ERROR") {
      status = "CRASHED";
    } else {
      status = "COMPLETED_WITH_ERRORS";
    }

    const finalizeService = new FinalizeTaskRunService();
    await finalizeService.call({
      id: taskRunAttempt.taskRunId,
      status,
      completedAt: failedAt,
      metadata: completion.metadata,
      env,
    });

    if (status !== "CRASHED" && status !== "SYSTEM_FAILURE") {
      return "COMPLETED";
    }

    const inProgressEvents = await eventRepository.queryIncompleteEvents(
      getTaskEventStoreTableForRun(taskRunAttempt.taskRun),
      {
        runId: taskRunAttempt.taskRun.friendlyId,
      },
      taskRunAttempt.taskRun.createdAt,
      taskRunAttempt.taskRun.completedAt ?? undefined
    );

    // Handle in-progress events
    switch (status) {
      case "CRASHED": {
        logger.debug("[CompleteAttemptService] Crashing in-progress events", {
          inProgressEvents: inProgressEvents.map((event) => event.id),
        });

        await Promise.all(
          inProgressEvents.map((event) => {
            return eventRepository.crashEvent({
              event,
              crashedAt: failedAt,
              exception: createExceptionPropertiesFromError(sanitizedError),
            });
          })
        );

        break;
      }
      case "SYSTEM_FAILURE": {
        logger.debug("[CompleteAttemptService] Failing in-progress events", {
          inProgressEvents: inProgressEvents.map((event) => event.id),
        });

        await Promise.all(
          inProgressEvents.map((event) => {
            return eventRepository.completeEvent(
              getTaskEventStoreTableForRun(taskRunAttempt.taskRun),
              event.spanId,
              taskRunAttempt.taskRun.createdAt,
              taskRunAttempt.taskRun.completedAt ?? undefined,
              {
                endTime: failedAt,
                attributes: {
                  isError: true,
                },
                events: [
                  {
                    name: "exception",
                    time: failedAt,
                    properties: {
                      exception: createExceptionPropertiesFromError(sanitizedError),
                    },
                  },
                ],
              }
            );
          })
        );
      }
    }

    return "COMPLETED";
  }

  async #enqueueReattempt({
    run,
    executionRetry,
    executionRetryInferred,
    checkpointEventId,
    supportsLazyAttempts,
    forceRequeue = false,
  }: {
    run: TaskRun;
    executionRetry: TaskRunExecutionRetry;
    executionRetryInferred: boolean;
    checkpointEventId?: string;
    supportsLazyAttempts: boolean;
    forceRequeue?: boolean;
  }) {
    const retryViaQueue = () => {
      logger.debug("[CompleteAttemptService] Enqueuing retry attempt", { runId: run.id });

      return marqs.requeueMessage(
        run.id,
        {
          type: "EXECUTE",
          taskIdentifier: run.taskIdentifier,
          checkpointEventId: this.opts.supportsRetryCheckpoints ? checkpointEventId : undefined,
          retryCheckpointsDisabled: !this.opts.supportsRetryCheckpoints,
        },
        executionRetry.timestamp,
        "retry"
      );
    };

    const retryDirectly = () => {
      logger.debug("[CompleteAttemptService] Retrying attempt directly", { runId: run.id });
      return RetryAttemptService.enqueue(run.id, this._prisma, new Date(executionRetry.timestamp));
    };

    // There's a checkpoint, so we need to go through the queue
    if (checkpointEventId) {
      if (!this.opts.supportsRetryCheckpoints) {
        logger.error(
          "[CompleteAttemptService] Worker does not support retry checkpoints, but a checkpoint was created",
          {
            runId: run.id,
            checkpointEventId,
          }
        );
      }

      logger.debug("[CompleteAttemptService] Enqueuing retry attempt with checkpoint", {
        runId: run.id,
      });
      await retryViaQueue();
      return;
    }

    // Workers without lazy attempt support always need to go through the queue, which is where the attempt is created
    if (!supportsLazyAttempts) {
      logger.debug("[CompleteAttemptService] Worker does not support lazy attempts", {
        runId: run.id,
      });
      await retryViaQueue();
      return;
    }

    if (forceRequeue) {
      logger.debug("[CompleteAttemptService] Forcing retry via queue", { runId: run.id });

      // The run won't know it should shut down as we make the decision to force requeue here
      // This also ensures that this change is backwards compatible with older workers
      exitRun(run.id);

      await retryViaQueue();
      return;
    }

    // Workers that never checkpoint between attempts will exit after completing their current attempt if the retry delay exceeds the threshold
    if (
      !this.opts.supportsRetryCheckpoints &&
      executionRetry.delay >= env.CHECKPOINT_THRESHOLD_IN_MS
    ) {
      logger.debug(
        "[CompleteAttemptService] Worker does not support retry checkpoints and the delay exceeds the threshold",
        { runId: run.id }
      );
      await retryViaQueue();
      return;
    }

    if (executionRetryInferred) {
      logger.debug("[CompleteAttemptService] Execution retry inferred, forcing retry via queue", {
        runId: run.id,
      });
      await retryViaQueue();
      return;
    }

    // The worker is still running and waiting for a retry message
    await retryDirectly();
  }

  async #retryAttempt({
    execution,
    executionRetry,
    executionRetryInferred,
    taskRunAttempt,
    environment,
    checkpoint,
    forceRequeue = false,
    oomMachine,
    error,
  }: {
    execution: TaskRunExecution;
    executionRetry: TaskRunExecutionRetry;
    executionRetryInferred: boolean;
    taskRunAttempt: NonNullable<FoundAttempt>;
    environment: AuthenticatedEnvironment;
    checkpoint?: CheckpointData;
    forceRequeue?: boolean;
    /** Setting this will also alter the retry span message */
    oomMachine?: MachinePresetName;
    error: TaskRunError;
  }) {
    const retryAt = new Date(executionRetry.timestamp);

    // Retry the task run
    await eventRepository.recordEvent(
      `Retry #${execution.attempt.number} delay${oomMachine ? " after OOM" : ""}`,
      {
        taskSlug: taskRunAttempt.taskRun.taskIdentifier,
        environment,
        attributes: {
          metadata: this.#generateMetadataAttributesForNextAttempt(execution),
          properties: {
            retryAt: retryAt.toISOString(),
            previousMachine: oomMachine
              ? taskRunAttempt.taskRun.machinePreset ?? undefined
              : undefined,
            nextMachine: oomMachine,
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
      }
    );

    logger.debug("[CompleteAttemptService] Retrying", {
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

    emitRunRetryScheduled({
      time: new Date(),
      run: {
        id: taskRunAttempt.taskRunId,
        status: "RETRYING_AFTER_FAILURE",
        friendlyId: taskRunAttempt.taskRun.friendlyId,
        spanId: taskRunAttempt.taskRun.spanId,
        attemptNumber: execution.attempt.number,
        queue: taskRunAttempt.taskRun.queue,
        traceContext: taskRunAttempt.taskRun.traceContext as Record<string, string | undefined>,
        taskIdentifier: taskRunAttempt.taskRun.taskIdentifier,
        baseCostInCents: taskRunAttempt.taskRun.baseCostInCents,
        updatedAt: taskRunAttempt.taskRun.updatedAt,
        error,
      },
      organization: {
        id: environment.organizationId,
      },
      environment: {
        ...environment,
        orgMember: environment.orgMember ?? null,
      },
      retryAt,
    });

    if (environment.type === "DEVELOPMENT") {
      await marqs.requeueMessage(taskRunAttempt.taskRunId, {}, executionRetry.timestamp, "retry");

      return "RETRIED";
    }

    if (checkpoint) {
      // This is only here for backwards compat - we don't checkpoint between attempts anymore
      return await this.#retryAttemptWithCheckpoint({
        execution,
        taskRunAttempt,
        executionRetry,
        executionRetryInferred,
        checkpoint,
      });
    }

    await this.#enqueueReattempt({
      run: taskRunAttempt.taskRun,
      executionRetry,
      supportsLazyAttempts: taskRunAttempt.backgroundWorker.supportsLazyAttempts,
      executionRetryInferred,
      forceRequeue,
    });

    return "RETRIED";
  }

  async #retryAttemptWithCheckpoint({
    execution,
    taskRunAttempt,
    executionRetry,
    executionRetryInferred,
    checkpoint,
  }: {
    execution: TaskRunExecution;
    taskRunAttempt: NonNullable<FoundAttempt>;
    executionRetry: TaskRunExecutionRetry;
    executionRetryInferred: boolean;
    checkpoint: CheckpointData;
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
      logger.error("[CompleteAttemptService] Failed to create reattempt checkpoint", {
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
      executionRetryInferred,
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
    return await this._prisma.runtimeEnvironment.findFirstOrThrow({
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
  return prismaClient.taskRunAttempt.findFirst({
    where: { friendlyId },
    include: {
      taskRun: true,
      backgroundWorkerTask: true,
      backgroundWorker: {
        select: {
          id: true,
          supportsLazyAttempts: true,
          sdkVersion: true,
        },
      },
    },
  });
}

function exitRun(runId: string) {
  socketIo.coordinatorNamespace.emit("REQUEST_RUN_CANCELLATION", {
    version: "v1",
    runId,
  });
}
