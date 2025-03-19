import { TaskRunExecutionStatus, TaskRunStatus } from "@trigger.dev/database";

export function isDequeueableExecutionStatus(status: TaskRunExecutionStatus): boolean {
  const dequeuableExecutionStatuses: TaskRunExecutionStatus[] = ["QUEUED", "QUEUED_EXECUTING"];
  return dequeuableExecutionStatuses.includes(status);
}

export function isExecuting(status: TaskRunExecutionStatus): boolean {
  const executingExecutionStatuses: TaskRunExecutionStatus[] = [
    "EXECUTING",
    "EXECUTING_WITH_WAITPOINTS",
  ];
  return executingExecutionStatuses.includes(status);
}

export function isPendingExecuting(status: TaskRunExecutionStatus): boolean {
  const pendingExecutionStatuses: TaskRunExecutionStatus[] = ["PENDING_EXECUTING"];
  return pendingExecutionStatuses.includes(status);
}

export function isCheckpointable(status: TaskRunExecutionStatus): boolean {
  const checkpointableStatuses: TaskRunExecutionStatus[] = [
    //will allow checkpoint starts
    "RUN_CREATED",
    "QUEUED",
    //executing
    "EXECUTING",
    "EXECUTING_WITH_WAITPOINTS",
    "QUEUED_EXECUTING",
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

export function canReleaseConcurrency(status: TaskRunExecutionStatus): boolean {
  const releaseableStatuses: TaskRunExecutionStatus[] = ["SUSPENDED", "EXECUTING_WITH_WAITPOINTS"];
  return releaseableStatuses.includes(status);
}
