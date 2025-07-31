import {
  calculateNextRetryDelay,
  RetryOptions,
  TaskRunExecution,
  TaskRunExecutionRetry,
  TaskRunFailedExecutionResult,
  V3TaskRunExecution,
} from "@trigger.dev/core/v3";
import type { Prisma, TaskRun } from "@trigger.dev/database";
import * as semver from "semver";
import { logger } from "~/services/logger.server";
import { sharedQueueTasks } from "./marqs/sharedQueueConsumer.server";
import { BaseService } from "./services/baseService.server";
import { CompleteAttemptService } from "./services/completeAttempt.server";
import { CreateTaskRunAttemptService } from "./services/createTaskRunAttempt.server";
import { isFailableRunStatus, isFinalAttemptStatus } from "./taskStatus";

const FailedTaskRunRetryGetPayload = {
  select: {
    id: true,
    attempts: {
      orderBy: {
        createdAt: "desc",
      },
      take: 1,
    },
    lockedById: true, // task
    lockedToVersionId: true, // worker
  },
} as const;

type TaskRunWithAttempts = Prisma.TaskRunGetPayload<typeof FailedTaskRunRetryGetPayload>;

export class FailedTaskRunService extends BaseService {
  public async call(anyRunId: string, completion: TaskRunFailedExecutionResult) {
    logger.debug("[FailedTaskRunService] Handling failed task run", { anyRunId, completion });

    const isFriendlyId = anyRunId.startsWith("run_");

    const taskRun = await this._prisma.taskRun.findFirst({
      where: {
        friendlyId: isFriendlyId ? anyRunId : undefined,
        id: !isFriendlyId ? anyRunId : undefined,
      },
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

    const retryHelper = new FailedTaskRunRetryHelper(this._prisma);
    const retryResult = await retryHelper.call({
      runId: taskRun.id,
      completion,
    });

    logger.debug("[FailedTaskRunService] Completion result", {
      runId: taskRun.id,
      result: retryResult,
    });
  }
}

interface TaskRunWithWorker extends TaskRun {
  lockedBy: { retryConfig: Prisma.JsonValue } | null;
  lockedToVersion: { sdkVersion: string } | null;
}

export class FailedTaskRunRetryHelper extends BaseService {
  async call({
    runId,
    completion,
    isCrash,
  }: {
    runId: string;
    completion: TaskRunFailedExecutionResult;
    isCrash?: boolean;
  }) {
    const taskRun = await this._prisma.taskRun.findFirst({
      where: {
        id: runId,
      },
      ...FailedTaskRunRetryGetPayload,
    });

    if (!taskRun) {
      logger.error("[FailedTaskRunRetryHelper] Task run not found", {
        runId,
        completion,
      });

      return "NO_TASK_RUN";
    }

    const retriableExecution = await this.#getRetriableAttemptExecution(taskRun, completion);

    if (!retriableExecution) {
      return "NO_EXECUTION";
    }

    logger.debug("[FailedTaskRunRetryHelper] Completing attempt", { taskRun, completion });

    const completeAttempt = new CompleteAttemptService({
      prisma: this._prisma,
      isSystemFailure: !isCrash,
      isCrash,
    });
    const completeResult = await completeAttempt.call({
      completion,
      execution: retriableExecution,
    });

    return completeResult;
  }

  async #getRetriableAttemptExecution(
    run: TaskRunWithAttempts,
    completion: TaskRunFailedExecutionResult
  ): Promise<V3TaskRunExecution | undefined> {
    let attempt = run.attempts[0];

    // We need to create an attempt if:
    // - None exists yet
    // - The last attempt has a final status, e.g. we failed between attempts
    if (!attempt || isFinalAttemptStatus(attempt.status)) {
      logger.debug("[FailedTaskRunRetryHelper] No attempts found", {
        run,
        completion,
      });

      const createAttempt = new CreateTaskRunAttemptService(this._prisma);

      try {
        const { execution } = await createAttempt.call({
          runId: run.id,
          // This ensures we correctly respect `maxAttempts = 1` when failing before the first attempt was created
          startAtZero: true,
        });
        return execution;
      } catch (error) {
        logger.error("[FailedTaskRunRetryHelper] Failed to create attempt", {
          run,
          completion,
          error,
        });

        return;
      }
    }

    // We already have an attempt with non-final status, let's use it
    try {
      const executionPayload = await sharedQueueTasks.getExecutionPayloadFromAttempt({
        id: attempt.id,
        skipStatusChecks: true,
      });

      return executionPayload?.execution;
    } catch (error) {
      logger.error("[FailedTaskRunRetryHelper] Failed to get execution payload", {
        run,
        completion,
        error,
      });

      return;
    }
  }

  static getExecutionRetry({
    run,
    execution,
  }: {
    run: TaskRunWithWorker;
    execution: TaskRunExecution;
  }): TaskRunExecutionRetry | undefined {
    try {
      const retryConfig = FailedTaskRunRetryHelper.getRetryConfig({ run, execution });
      if (!retryConfig) {
        return;
      }

      const delay = calculateNextRetryDelay(retryConfig, execution.attempt.number);

      if (!delay) {
        logger.debug("[FailedTaskRunRetryHelper] No more retries", {
          run,
          execution,
        });

        return;
      }

      return {
        timestamp: Date.now() + delay,
        delay,
      };
    } catch (error) {
      logger.error("[FailedTaskRunRetryHelper] Failed to get execution retry", {
        run,
        execution,
        error,
      });

      return;
    }
  }

  static getRetryConfig({
    run,
    execution,
  }: {
    run: TaskRunWithWorker;
    execution: TaskRunExecution;
  }): RetryOptions | undefined {
    try {
      const retryConfig = run.lockedBy?.retryConfig;

      if (!retryConfig) {
        if (!run.lockedToVersion) {
          logger.error("[FailedTaskRunRetryHelper] Run not locked to version", {
            run,
            execution,
          });

          return;
        }

        const sdkVersion = run.lockedToVersion.sdkVersion ?? "0.0.0";
        const isValid = semver.valid(sdkVersion);

        if (!isValid) {
          logger.error("[FailedTaskRunRetryHelper] Invalid SDK version", {
            run,
            execution,
          });

          return;
        }

        // With older SDK versions, tasks only have a retry config stored in the DB if it's explicitly defined on the task itself
        // It won't get populated with retry.default in trigger.config.ts
        if (semver.lt(sdkVersion, FailedTaskRunRetryHelper.DEFAULT_RETRY_CONFIG_SINCE_VERSION)) {
          logger.warn(
            "[FailedTaskRunRetryHelper] SDK version not recent enough to determine retry config",
            {
              run,
              execution,
            }
          );

          return;
        }
      }

      const parsedRetryConfig = RetryOptions.nullable().safeParse(retryConfig);

      if (!parsedRetryConfig.success) {
        logger.error("[FailedTaskRunRetryHelper] Invalid retry config", {
          run,
          execution,
        });

        return;
      }

      if (!parsedRetryConfig.data) {
        logger.debug("[FailedTaskRunRetryHelper] No retry config", {
          run,
          execution,
        });

        return;
      }

      return parsedRetryConfig.data;
    } catch (error) {
      logger.error("[FailedTaskRunRetryHelper] Failed to get execution retry", {
        run,
        execution,
        error,
      });

      return;
    }
  }

  static DEFAULT_RETRY_CONFIG_SINCE_VERSION = "3.1.0";
}
