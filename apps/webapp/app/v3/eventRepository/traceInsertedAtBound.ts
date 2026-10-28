import type { TaskRunStatus } from "@trigger.dev/database";
import { isFinalRunStatus } from "~/v3/taskStatus";

// Spans in a run's subtree can finish after the run, so their final rows land later.
const TRACE_INSERTED_AT_END_BUFFER_MS = 7 * 24 * 60 * 60 * 1000;

// Covers rows a cancelled run's worker writes after the run row's last update.
const TRACE_START_TIME_UPDATED_AT_SLACK_MS = 10 * 60 * 1000;

type RunFinishFields = {
  status: TaskRunStatus;
  completedAt: Date | null;
  updatedAt: Date;
};

// Some final runs (e.g. cancelled ones) never get a completedAt.
export function getRunFinishedAt(run: RunFinishFields): Date | undefined {
  if (run.completedAt) {
    return run.completedAt;
  }

  return isFinalRunStatus(run.status) ? run.updatedAt : undefined;
}

// Trade-off: a child finishing more than 7 days after the run shows as still running.
export function getTraceInsertedAtEnd(run: RunFinishFields): Date | undefined {
  const finishedAt = getRunFinishedAt(run);
  if (!finishedAt || !isFinalRunStatus(run.status)) {
    return undefined;
  }

  return new Date(finishedAt.getTime() + TRACE_INSERTED_AT_END_BUFFER_MS);
}

export function getTraceStartTimeEnd(run: RunFinishFields): Date | undefined {
  const finishedAt = getRunFinishedAt(run);
  if (!finishedAt || run.completedAt) {
    return finishedAt;
  }

  return new Date(finishedAt.getTime() + TRACE_START_TIME_UPDATED_AT_SLACK_MS);
}
