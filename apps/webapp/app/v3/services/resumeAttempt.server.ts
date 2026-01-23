import {
  CoordinatorToPlatformMessages,
  TaskRunExecution,
  TaskRunExecutionResult,
} from "@trigger.dev/core/v3";
import type { InferSocketMessageSchema } from "@trigger.dev/core/v3/zodSocket";
import { logger } from "~/services/logger.server";
import { marqs } from "~/v3/marqs/index.server";
import { taskRunRouter } from "~/v3/taskRunRouter.server";
import { socketIo } from "../handleSocketIo.server";
import { sharedQueueTasks } from "../marqs/sharedQueueConsumer.server";
import { BaseService } from "./baseService.server";
import { TaskRun, TaskRunAttempt } from "@trigger.dev/database";
import { FINAL_ATTEMPT_STATUSES, isFinalRunStatus } from "../taskStatus";

export class ResumeAttemptService extends BaseService {
  private _logger = logger;

  public async call(
    params: InferSocketMessageSchema<typeof CoordinatorToPlatformMessages, "READY_FOR_RESUME">
  ): Promise<void> {
    this._logger.debug(`ResumeAttemptService.call()`, params);

    const attempt = await this._prisma.taskRunAttempt.findFirst({
      where: {
        friendlyId: params.attemptFriendlyId,
      },
      include: {
        dependencies: {
          select: {
            taskRunId: true,
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        },
        batchDependencies: {
          select: {
            items: {
              select: {
                taskRunId: true,
              },
            },
          },
          orderBy: {
            createdAt: "desc",
          },
          take: 1,
        },
      },
    });

    if (!attempt) {
      this._logger.error("Could not find attempt", params);
      return;
    }

    const taskRun = await taskRunRouter.findById(attempt.taskRunId);

    if (!taskRun) {
      this._logger.error("Could not find task run for attempt", {
        ...params,
        taskRunId: attempt.taskRunId,
      });
      return;
    }

    this._logger = logger.child({
      attemptId: attempt.id,
      attemptFriendlyId: attempt.friendlyId,
      taskRun,
    });

    if (isFinalRunStatus(taskRun.status)) {
      this._logger.error("Run is not resumable");
      return;
    }

    let completedAttemptIds: string[] = [];

    switch (params.type) {
      case "WAIT_FOR_DURATION": {
        this._logger.debug("Sending duration wait resume message");

        await this.#setPostResumeStatuses(attempt, taskRun);

        socketIo.coordinatorNamespace.emit("RESUME_AFTER_DURATION", {
          version: "v1",
          attemptId: attempt.id,
          attemptFriendlyId: attempt.friendlyId,
        });
        break;
      }
      case "WAIT_FOR_TASK": {
        if (attempt.dependencies.length) {
          // We only care about the latest dependency
          const dependentTaskRunId = attempt.dependencies[0].taskRunId;

          // Fetch the latest attempt for the dependent task run (FK removed for TaskRun partitioning)
          const dependentAttempt = await this._prisma.taskRunAttempt.findFirst({
            where: { taskRunId: dependentTaskRunId },
            orderBy: { number: "desc" },
            take: 1,
            select: { id: true, number: true, status: true },
          });

          if (!dependentAttempt) {
            this._logger.error("No dependent attempt");
            return;
          }

          completedAttemptIds = [dependentAttempt.id];
        } else {
          this._logger.error("No task dependency");
          return;
        }

        await this.#handleDependencyResume(attempt, taskRun, completedAttemptIds);

        break;
      }
      case "WAIT_FOR_BATCH": {
        if (attempt.batchDependencies && attempt.batchDependencies.length > 0) {
          // We only care about the latest batch dependency
          const dependentBatchItems = attempt.batchDependencies[0].items;

          if (!dependentBatchItems || dependentBatchItems.length === 0) {
            this._logger.error("No dependent batch items");
            return;
          }

          // Get all task run IDs from the batch items
          const taskRunIds = dependentBatchItems.map((item) => item.taskRunId);

          // Fetch all attempts for these task runs (FK removed for TaskRun partitioning)
          const allAttempts = await this._prisma.taskRunAttempt.findMany({
            where: {
              taskRunId: { in: taskRunIds },
              status: { in: FINAL_ATTEMPT_STATUSES },
            },
            orderBy: { number: "desc" },
            select: { id: true, number: true, status: true, taskRunId: true },
          });

          // Group attempts by taskRunId and find the best one for each
          const attemptsByRunId = new Map<string, typeof allAttempts>();
          for (const att of allAttempts) {
            const existing = attemptsByRunId.get(att.taskRunId) ?? [];
            existing.push(att);
            attemptsByRunId.set(att.taskRunId, existing);
          }

          // Find the best attempt for each batch item (most recent in final state)
          const finalAttempts = taskRunIds
            .map((runId) => {
              const attempts = attemptsByRunId.get(runId) ?? [];
              return attempts.sort((a, b) => b.number - a.number).at(0);
            })
            .filter(Boolean);

          completedAttemptIds = finalAttempts.map((a) => a.id);

          if (completedAttemptIds.length !== dependentBatchItems.length) {
            this._logger.error("[ResumeAttemptService] not all batch items have attempts", {
              runId: attempt.taskRunId,
              completedAttemptIds,
              finalAttempts,
              dependentBatchItems,
            });

            return;
          }
        } else {
          this._logger.error("No batch dependency");
          return;
        }

        await this.#handleDependencyResume(attempt, taskRun, completedAttemptIds);

        break;
      }
      default: {
        break;
      }
    }
  }

  async #handleDependencyResume(
    attempt: TaskRunAttempt,
    taskRun: TaskRun,
    completedAttemptIds: string[]
  ) {
    if (completedAttemptIds.length === 0) {
      this._logger.error("No completed attempt IDs");
      return;
    }

    const completions: TaskRunExecutionResult[] = [];
    const executions: TaskRunExecution[] = [];

    for (const completedAttemptId of completedAttemptIds) {
      const completedAttempt = await this._prisma.taskRunAttempt.findFirst({
        where: {
          id: completedAttemptId,
        },
      });

      if (!completedAttempt) {
        this._logger.error("Completed attempt not found", { completedAttemptId });
        await marqs?.acknowledgeMessage(
          attempt.taskRunId,
          "Cannot find completed attempt in ResumeAttemptService"
        );
        return;
      }

      // Check that the completed attempt's taskRun is locked
      const completedTaskRun = await taskRunRouter.findById(completedAttempt.taskRunId);
      if (!completedTaskRun || !completedTaskRun.lockedAt || !completedTaskRun.lockedById) {
        this._logger.error("Completed attempt's task run is not locked", {
          completedAttemptId,
          taskRunId: completedAttempt.taskRunId,
        });
        await marqs?.acknowledgeMessage(
          attempt.taskRunId,
          "Cannot find completed attempt in ResumeAttemptService"
        );
        return;
      }

      const logger = this._logger.child({
        completedAttemptId: completedAttempt.id,
        completedAttemptFriendlyId: completedAttempt.friendlyId,
        completedRunId: completedAttempt.taskRunId,
      });

      const resumePayload = await sharedQueueTasks.getResumePayload(completedAttempt.id);

      if (!resumePayload) {
        logger.error("Failed to get resume payload");
        await marqs?.acknowledgeMessage(
          attempt.taskRunId,
          "Failed to get resume payload in ResumeAttemptService"
        );
        return;
      }

      completions.push(resumePayload.completion);
      executions.push(resumePayload.execution);
    }

    await this.#setPostResumeStatuses(attempt, taskRun);

    socketIo.coordinatorNamespace.emit("RESUME_AFTER_DEPENDENCY", {
      version: "v1",
      runId: attempt.taskRunId,
      attemptId: attempt.id,
      attemptFriendlyId: attempt.friendlyId,
      completions,
      executions,
    });
  }

  async #setPostResumeStatuses(attempt: TaskRunAttempt, taskRun: TaskRun) {
    try {
      const newRunStatus = attempt.number > 1 ? "RETRYING_AFTER_FAILURE" : "EXECUTING";

      const updatedAttempt = await this._prisma.taskRunAttempt.update({
        where: {
          id: attempt.id,
        },
        data: {
          status: "EXECUTING",
        },
        select: {
          id: true,
          status: true,
        },
      });

      await taskRunRouter.updateById(attempt.taskRunId, {
        status: newRunStatus,
      });

      this._logger.debug("Set post resume statuses", {
        run: {
          id: taskRun.id,
          status: newRunStatus,
        },
        attempt: {
          id: updatedAttempt.id,
          status: updatedAttempt.status,
        },
      });
    } catch (error) {
      this._logger.error("Failed to set post resume statuses", {
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack,
              }
            : error,
      });
    }
  }
}
