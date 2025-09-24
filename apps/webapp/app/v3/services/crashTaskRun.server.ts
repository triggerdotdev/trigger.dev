import { TaskRun, TaskRunAttempt } from "@trigger.dev/database";
import { eventRepository } from "../eventRepository.server";
import { BaseService } from "./baseService.server";
import { logger } from "~/services/logger.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { CRASHABLE_ATTEMPT_STATUSES, isCrashableRunStatus } from "../taskStatus";
import { sanitizeError, TaskRunErrorCodes, TaskRunInternalError } from "@trigger.dev/core/v3";
import { FinalizeTaskRunService } from "./finalizeTaskRun.server";
import { FailedTaskRunRetryHelper } from "../failedTaskRun.server";
import { getTaskEventStoreTableForRun } from "../taskEventStore.server";
import { tryCatch } from "@trigger.dev/core/utils";

export type CrashTaskRunServiceOptions = {
  reason?: string;
  exitCode?: number;
  logs?: string;
  crashAttempts?: boolean;
  crashedAt?: Date;
  overrideCompletion?: boolean;
  errorCode?: TaskRunInternalError["code"];
};

export class CrashTaskRunService extends BaseService {
  public async call(runId: string, options?: CrashTaskRunServiceOptions) {
    const opts = {
      reason: "Worker crashed",
      crashAttempts: true,
      crashedAt: new Date(),
      ...options,
    };

    logger.debug("CrashTaskRunService.call", { runId, opts });

    if (options?.overrideCompletion) {
      logger.error("CrashTaskRunService.call: overrideCompletion is deprecated", { runId });
      return;
    }

    const taskRun = await this._prisma.taskRun.findFirst({
      where: {
        id: runId,
      },
    });

    if (!taskRun) {
      logger.error("[CrashTaskRunService] Task run not found", { runId });
      return;
    }

    // Make sure the task run is in a crashable state
    if (!opts.overrideCompletion && !isCrashableRunStatus(taskRun.status)) {
      logger.error("[CrashTaskRunService] Task run is not in a crashable state", {
        runId,
        status: taskRun.status,
      });
      return;
    }

    logger.debug("[CrashTaskRunService] Completing attempt", { runId, options });

    const retryHelper = new FailedTaskRunRetryHelper(this._prisma);
    const retryResult = await retryHelper.call({
      runId,
      completion: {
        ok: false,
        id: runId,
        error: {
          type: "INTERNAL_ERROR",
          code: opts.errorCode ?? TaskRunErrorCodes.TASK_RUN_CRASHED,
          message: opts.reason,
          stackTrace: opts.logs,
        },
      },
      isCrash: true,
    });

    logger.debug("[CrashTaskRunService] Completion result", { runId, retryResult });

    if (retryResult === "RETRIED") {
      logger.debug("[CrashTaskRunService] Retried task run", { runId });
      return;
    }

    if (!opts.overrideCompletion) {
      return;
    }

    logger.debug("[CrashTaskRunService] Overriding completion", { runId, options });

    const finalizeService = new FinalizeTaskRunService();
    const crashedTaskRun = await finalizeService.call({
      id: taskRun.id,
      status: "CRASHED",
      completedAt: new Date(),
      include: {
        attempts: {
          where: {
            status: {
              in: CRASHABLE_ATTEMPT_STATUSES,
            },
          },
          include: {
            backgroundWorker: true,
            runtimeEnvironment: true,
          },
        },
        dependency: true,
        runtimeEnvironment: {
          include: {
            organization: true,
            project: true,
          },
        },
      },
      attemptStatus: "FAILED",
      error: {
        type: "INTERNAL_ERROR",
        code: opts.errorCode ?? TaskRunErrorCodes.TASK_RUN_CRASHED,
        message: opts.reason,
        stackTrace: opts.logs,
      },
    });

    const [createAttemptFailedEventError] = await tryCatch(
      eventRepository.completeFailedRunEvent({
        run: crashedTaskRun,
        endTime: opts.crashedAt,
        exception: {
          type: opts.errorCode ?? TaskRunErrorCodes.TASK_RUN_CRASHED,
          message: opts.reason,
          stacktrace: opts.logs,
        },
      })
    );

    if (createAttemptFailedEventError) {
      logger.error("[CrashTaskRunService] Failed to complete failed run event", {
        error: createAttemptFailedEventError,
        runId: crashedTaskRun.id,
      });
    }

    if (!opts.crashAttempts) {
      return;
    }

    // Cancel any in progress attempts
    for (const attempt of crashedTaskRun.attempts) {
      await this.#failAttempt(
        attempt,
        crashedTaskRun,
        new Date(),
        crashedTaskRun.runtimeEnvironment,
        {
          reason: opts.reason,
          logs: opts.logs,
          code: opts.errorCode,
        }
      );
    }
  }

  async #failAttempt(
    attempt: TaskRunAttempt,
    run: TaskRun,
    failedAt: Date,
    environment: AuthenticatedEnvironment,
    error: {
      reason: string;
      logs?: string;
      code?: TaskRunInternalError["code"];
    }
  ) {
    return await this.traceWithEnv(
      "[CrashTaskRunService] failAttempt()",
      environment,
      async (span) => {
        span.setAttribute("taskRunId", run.id);
        span.setAttribute("attemptId", attempt.id);

        await this._prisma.taskRunAttempt.update({
          where: {
            id: attempt.id,
          },
          data: {
            status: "FAILED",
            completedAt: failedAt,
            error: sanitizeError({
              type: "INTERNAL_ERROR",
              code: error.code ?? TaskRunErrorCodes.TASK_RUN_CRASHED,
              message: error.reason,
              stackTrace: error.logs,
            }),
          },
        });
      }
    );
  }
}
