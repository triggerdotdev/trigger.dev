import type { JobRun, JobRunStatus } from "@trigger.dev/database";

const COMPLETED_STATUSES: Array<JobRun["status"]> = [
  "CANCELED",
  "ABORTED",
  "SUCCESS",
  "TIMED_OUT",
  "INVALID_PAYLOAD",
  "FAILURE",
  "UNRESOLVED_AUTH",
];

export function isRunCompleted(status: JobRunStatus) {
  return COMPLETED_STATUSES.includes(status);
}

export type RunBasicStatus = "WAITING" | "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";

export function runBasicStatus(status: JobRunStatus): RunBasicStatus {
  switch (status) {
    case "WAITING_ON_CONNECTIONS":
    case "QUEUED":
    case "PREPROCESSING":
    case "PENDING":
      return "PENDING";
    case "STARTED":
    case "EXECUTING":
    case "WAITING_TO_CONTINUE":
    case "WAITING_TO_EXECUTE":
      return "RUNNING";
    case "FAILURE":
    case "TIMED_OUT":
    case "UNRESOLVED_AUTH":
    case "CANCELED":
    case "ABORTED":
    case "INVALID_PAYLOAD":
      return "FAILED";
    case "SUCCESS":
      return "COMPLETED";
    default: {
      const _exhaustiveCheck: never = status;
      throw new Error(`Non-exhaustive match for value: ${status}`);
    }
  }
}
