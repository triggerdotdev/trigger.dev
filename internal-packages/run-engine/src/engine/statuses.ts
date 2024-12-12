import { TaskRunExecutionStatus, TaskRunStatus } from "@trigger.dev/database";

export function isDequeueableExecutionStatus(status: TaskRunExecutionStatus): boolean {
  const dequeuableExecutionStatuses: TaskRunExecutionStatus[] = ["QUEUED"];
  return dequeuableExecutionStatuses.includes(status);
}

export function isExecuting(status: TaskRunExecutionStatus): boolean {
  const executingExecutionStatuses: TaskRunExecutionStatus[] = [
    "EXECUTING",
    "EXECUTING_WITH_WAITPOINTS",
  ];
  return executingExecutionStatuses.includes(status);
}

export function isCheckpointable(status: TaskRunExecutionStatus): boolean {
  const checkpointableStatuses: TaskRunExecutionStatus[] = [
    //will allow checkpoint starts
    "RUN_CREATED",
    "QUEUED",
    //executing
    "EXECUTING",
    "EXECUTING_WITH_WAITPOINTS",
  ];
  return checkpointableStatuses.includes(status);
}

export function isFinalRunStatus(status: TaskRunStatus): boolean {
  const finalStatuses: TaskRunStatus[] = [
    "CANCELED",
    "INTERRUPTED",
    "COMPLETED_SUCCESSFULLY",
    "COMPLETED_WITH_ERRORS",
    "SYSTEM_FAILURE",
    "CRASHED",
    "EXPIRED",
    "TIMED_OUT",
  ];

  return finalStatuses.includes(status);
}
