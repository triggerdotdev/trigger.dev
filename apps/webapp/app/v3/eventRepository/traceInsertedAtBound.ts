import type { TaskRunStatus } from "@trigger.dev/database";
import { isFinalRunStatus } from "~/v3/taskStatus";

// Spans in a run's subtree can finish after the run, so their final rows land later.
const TRACE_INSERTED_AT_END_BUFFER_MS = 7 * 24 * 60 * 60 * 1000;

export function getTraceInsertedAtEnd(run: {
  status: TaskRunStatus;
  completedAt: Date | null;
  updatedAt: Date;
}): Date | undefined {
  if (!isFinalRunStatus(run.status)) {
    return undefined;
  }

  const finishedAt = run.completedAt ?? run.updatedAt;
  return new Date(finishedAt.getTime() + TRACE_INSERTED_AT_END_BUFFER_MS);
}
