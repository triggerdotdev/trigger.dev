import type {
  TaskRunExecutionResult,
  TaskRunFailedExecutionResult,
  TaskRunSuccessfulExecutionResult,
} from "@trigger.dev/core/v3";
import { TaskRunError, TaskRunErrorCodes } from "@trigger.dev/core/v3";

import type {
  BatchTaskRunItemStatus as BatchTaskRunItemStatusType,
  TaskRun,
  TaskRunAttempt,
  TaskRunStatus as TaskRunStatusType,
} from "@trigger.dev/database";

import { assertNever } from "assert-never";
import { BatchTaskRunItemStatus, TaskRunAttemptStatus, TaskRunStatus } from "~/database-types";
import { logger } from "~/services/logger.server";

const SUCCESSFUL_STATUSES = [TaskRunStatus.COMPLETED_SUCCESSFULLY];
const FAILURE_STATUSES = [
  TaskRunStatus.CANCELED,
  TaskRunStatus.INTERRUPTED,
  TaskRunStatus.COMPLETED_WITH_ERRORS,
  TaskRunStatus.SYSTEM_FAILURE,
  TaskRunStatus.CRASHED,
];

export type TaskRunWithAttempts = TaskRun & {
  attempts: TaskRunAttempt[];
};

export function executionResultForTaskRun(
  taskRun: TaskRunWithAttempts
): TaskRunExecutionResult | undefined {
  if (SUCCESSFUL_STATUSES.includes(taskRun.status)) {
    // Run-engine runs write no attempt rows: the result lives on the run itself.
    const source =
      taskRun.attempts.find((a) => a.status === TaskRunAttemptStatus.COMPLETED) ?? taskRun;

    return {
      ok: true,
      id: taskRun.friendlyId,
      taskIdentifier: taskRun.taskIdentifier,
      output: source.output ?? undefined,
      outputType: source.outputType,
    } satisfies TaskRunSuccessfulExecutionResult;
  }

  if (FAILURE_STATUSES.includes(taskRun.status)) {
    if (taskRun.status === TaskRunStatus.CANCELED) {
      return {
        ok: false,
        id: taskRun.friendlyId,
        taskIdentifier: taskRun.taskIdentifier,
        error: {
          type: "INTERNAL_ERROR",
          code: TaskRunErrorCodes.TASK_RUN_CANCELLED,
        },
      } satisfies TaskRunFailedExecutionResult;
    }

    const source =
      taskRun.attempts.find((a) => a.status === TaskRunAttemptStatus.FAILED) ?? taskRun;

    const error = TaskRunError.safeParse(source.error);

    if (!error.success) {
      logger.error("Failed to parse error from failed task run attempt", {
        taskRunId: taskRun.id,
        taskRunStatus: taskRun.status,
        taskRunAttempts: taskRun.attempts.map((a) => a.status),
        error: source.error,
      });

      return {
        ok: false,
        id: taskRun.friendlyId,
        taskIdentifier: taskRun.taskIdentifier,
        error: {
          type: "INTERNAL_ERROR",
          code: TaskRunErrorCodes.CONFIGURED_INCORRECTLY,
        },
      } satisfies TaskRunFailedExecutionResult;
    }

    return {
      ok: false,
      id: taskRun.friendlyId,
      taskIdentifier: taskRun.taskIdentifier,
      error: error.data,
    } satisfies TaskRunFailedExecutionResult;
  }
}

export function batchTaskRunItemStatusForRunStatus(
  status: TaskRunStatusType
): BatchTaskRunItemStatusType {
  switch (status) {
    case TaskRunStatus.COMPLETED_SUCCESSFULLY:
      return BatchTaskRunItemStatus.COMPLETED;
    case TaskRunStatus.CANCELED:
    case TaskRunStatus.INTERRUPTED:
    case TaskRunStatus.COMPLETED_WITH_ERRORS:
    case TaskRunStatus.SYSTEM_FAILURE:
    case TaskRunStatus.CRASHED:
    case TaskRunStatus.EXPIRED:
    case TaskRunStatus.TIMED_OUT:
      return BatchTaskRunItemStatus.FAILED;
    case TaskRunStatus.PENDING:
    case TaskRunStatus.PENDING_VERSION:
    case TaskRunStatus.WAITING_FOR_DEPLOY:
    case TaskRunStatus.WAITING_TO_RESUME:
    case TaskRunStatus.RETRYING_AFTER_FAILURE:
    case TaskRunStatus.DEQUEUED:
    case TaskRunStatus.EXECUTING:
    case TaskRunStatus.PAUSED:
    case TaskRunStatus.DELAYED:
      return BatchTaskRunItemStatus.PENDING;
    default:
      assertNever(status);
  }
}
