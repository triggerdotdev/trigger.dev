import type { TaskRunAttemptStatus, TaskRunStatus } from "@trigger.dev/database";

export const CANCELLABLE_RUN_STATUSES: TaskRunStatus[] = [
  "DELAYED",
  "PENDING",
  "WAITING_FOR_DEPLOY",
  "EXECUTING",
  "PAUSED",
  "WAITING_TO_RESUME",
  "PAUSED",
  "RETRYING_AFTER_FAILURE",
];
export const CANCELLABLE_ATTEMPT_STATUSES: TaskRunAttemptStatus[] = [
  "EXECUTING",
  "PAUSED",
  "PENDING",
];

export function isCancellableRunStatus(status: TaskRunStatus): boolean {
  return CANCELLABLE_RUN_STATUSES.includes(status);
}
export function isCancellableAttemptStatus(status: TaskRunAttemptStatus): boolean {
  return CANCELLABLE_ATTEMPT_STATUSES.includes(status);
}

export const CRASHABLE_RUN_STATUSES: TaskRunStatus[] = CANCELLABLE_RUN_STATUSES;
export const CRASHABLE_ATTEMPT_STATUSES: TaskRunAttemptStatus[] = CANCELLABLE_ATTEMPT_STATUSES;

export function isCrashableRunStatus(status: TaskRunStatus): boolean {
  return CRASHABLE_RUN_STATUSES.includes(status);
}
export function isCrashableAttemptStatus(status: TaskRunAttemptStatus): boolean {
  return CRASHABLE_ATTEMPT_STATUSES.includes(status);
}

export const FINAL_RUN_STATUSES = [
  "CANCELED",
  "COMPLETED_SUCCESSFULLY",
  "COMPLETED_WITH_ERRORS",
  "INTERRUPTED",
  "SYSTEM_FAILURE",
  "EXPIRED",
  "CRASHED",
] satisfies TaskRunStatus[];

export type FINAL_RUN_STATUSES = (typeof FINAL_RUN_STATUSES)[number];

export const FINAL_ATTEMPT_STATUSES: TaskRunAttemptStatus[] = ["CANCELED", "COMPLETED", "FAILED"];

export const FREEZABLE_RUN_STATUSES: TaskRunStatus[] = ["EXECUTING", "RETRYING_AFTER_FAILURE"];
export const FREEZABLE_ATTEMPT_STATUSES: TaskRunAttemptStatus[] = ["EXECUTING", "FAILED"];

export function isFreezableRunStatus(status: TaskRunStatus): boolean {
  return FREEZABLE_RUN_STATUSES.includes(status);
}
export function isFreezableAttemptStatus(status: TaskRunAttemptStatus): boolean {
  return FREEZABLE_ATTEMPT_STATUSES.includes(status);
}

export function isFinalRunStatus(status: TaskRunStatus): boolean {
  return FINAL_RUN_STATUSES.includes(status);
}
export function isFinalAttemptStatus(status: TaskRunAttemptStatus): boolean {
  return FINAL_ATTEMPT_STATUSES.includes(status);
}

export const RESTORABLE_RUN_STATUSES: TaskRunStatus[] = ["WAITING_TO_RESUME"];
export const RESTORABLE_ATTEMPT_STATUSES: TaskRunAttemptStatus[] = ["PAUSED"];

export function isRestorableRunStatus(status: TaskRunStatus): boolean {
  return RESTORABLE_RUN_STATUSES.includes(status);
}
export function isRestorableAttemptStatus(status: TaskRunAttemptStatus): boolean {
  return RESTORABLE_ATTEMPT_STATUSES.includes(status);
}

export const FAILABLE_RUN_STATUSES = [
  "EXECUTING",
  "PENDING",
  "WAITING_FOR_DEPLOY",
  "RETRYING_AFTER_FAILURE",
] satisfies TaskRunStatus[];

export const FAILED_RUN_STATUSES = [
  "INTERRUPTED",
  "COMPLETED_WITH_ERRORS",
  "SYSTEM_FAILURE",
  "CRASHED",
] satisfies TaskRunStatus[];

export function isFailedRunStatus(status: TaskRunStatus): boolean {
  return FAILED_RUN_STATUSES.includes(status);
}
