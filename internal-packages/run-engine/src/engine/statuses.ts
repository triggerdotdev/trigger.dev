import { TaskRunExecutionStatus } from "@trigger.dev/database";

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
