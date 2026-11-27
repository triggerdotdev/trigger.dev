import type { RunStatus } from "@trigger.dev/core/v3";
import type { TaskRunStatus } from "@trigger.dev/database";
import type { RunStatusUnspecifiedApiVersion } from "~/api/versions";

// The SDK/API run status names and the dashboard statuses each one covers.
// Shared by the runs API, the bulk actions API and dashboard URL filters, so all three agree.
const apiRunStatusToTaskRunStatuses: Record<
  RunStatus | RunStatusUnspecifiedApiVersion,
  TaskRunStatus[]
> = {
  DELAYED: ["DELAYED"],
  PENDING_VERSION: ["PENDING_VERSION"],
  WAITING_FOR_DEPLOY: ["WAITING_FOR_DEPLOY"],
  QUEUED: ["PENDING"],
  DEQUEUED: ["DEQUEUED"],
  EXECUTING: ["EXECUTING"],
  REATTEMPTING: ["RETRYING_AFTER_FAILURE"],
  FROZEN: ["PAUSED", "WAITING_TO_RESUME"],
  WAITING: ["WAITING_TO_RESUME"],
  CANCELED: ["CANCELED"],
  COMPLETED: ["COMPLETED_SUCCESSFULLY"],
  FAILED: ["COMPLETED_WITH_ERRORS"],
  SYSTEM_FAILURE: ["SYSTEM_FAILURE"],
  INTERRUPTED: ["INTERRUPTED"],
  CRASHED: ["CRASHED"],
  EXPIRED: ["EXPIRED"],
  TIMED_OUT: ["TIMED_OUT"],
};

export function apiStatusToRunStatuses(
  status: RunStatus | RunStatusUnspecifiedApiVersion
): TaskRunStatus[] {
  return apiRunStatusToTaskRunStatuses[status];
}

/** Returns the dashboard statuses for an SDK/API status name, or undefined if it isn't one. */
export function apiStatusNameToRunStatuses(name: string): TaskRunStatus[] | undefined {
  return Object.hasOwn(apiRunStatusToTaskRunStatuses, name)
    ? apiRunStatusToTaskRunStatuses[name as RunStatus]
    : undefined;
}
