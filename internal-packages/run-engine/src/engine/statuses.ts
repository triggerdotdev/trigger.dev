import { TaskRunExecutionStatus } from "@trigger.dev/database";

export function isDequeueableExecutionStatus(status: TaskRunExecutionStatus): boolean {
  const dequeuableExecutionStatuses: TaskRunExecutionStatus[] = ["QUEUED", "BLOCKED_BY_WAITPOINTS"];
  return dequeuableExecutionStatuses.includes(status);
}
