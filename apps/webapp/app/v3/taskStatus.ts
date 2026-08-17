import type { TaskRunAttemptStatus, TaskRunStatus } from "@trigger.dev/database";

export const FINAL_RUN_STATUSES = [
  "CANCELED",
  "INTERRUPTED",
  "COMPLETED_SUCCESSFULLY",
  "COMPLETED_WITH_ERRORS",
  "SYSTEM_FAILURE",
  "CRASHED",
  "EXPIRED",
  "TIMED_OUT",
] satisfies TaskRunStatus[];

export type FINAL_RUN_STATUSES = (typeof FINAL_RUN_STATUSES)[number];

const NON_FINAL_RUN_STATUSES = [
  "DELAYED",
  "PENDING",
  "PENDING_VERSION",
  "WAITING_FOR_DEPLOY",
  "DEQUEUED",
  "EXECUTING",
  "WAITING_TO_RESUME",
  "RETRYING_AFTER_FAILURE",
  "PAUSED",
] satisfies TaskRunStatus[];

type NON_FINAL_RUN_STATUSES = (typeof NON_FINAL_RUN_STATUSES)[number];

const PENDING_STATUSES = [
  "PENDING",
  "PENDING_VERSION",
  "WAITING_FOR_DEPLOY",
] satisfies TaskRunStatus[];

type PENDING_STATUSES = (typeof PENDING_STATUSES)[number];

export const FINAL_ATTEMPT_STATUSES = [
  "FAILED",
  "CANCELED",
  "COMPLETED",
] satisfies TaskRunAttemptStatus[];

export type FINAL_ATTEMPT_STATUSES = (typeof FINAL_ATTEMPT_STATUSES)[number];

const NON_FINAL_ATTEMPT_STATUSES = [
  "PENDING",
  "EXECUTING",
  "PAUSED",
] satisfies TaskRunAttemptStatus[];

type NON_FINAL_ATTEMPT_STATUSES = (typeof NON_FINAL_ATTEMPT_STATUSES)[number];

const FAILED_RUN_STATUSES = [
  "INTERRUPTED",
  "COMPLETED_WITH_ERRORS",
  "SYSTEM_FAILURE",
  "CRASHED",
  "TIMED_OUT",
] satisfies TaskRunStatus[];

type FAILED_RUN_STATUSES = (typeof FAILED_RUN_STATUSES)[number];

const FATAL_RUN_STATUSES = ["SYSTEM_FAILURE", "CRASHED"] satisfies TaskRunStatus[];

type FATAL_RUN_STATUSES = (typeof FAILED_RUN_STATUSES)[number];

const CANCELLABLE_RUN_STATUSES = NON_FINAL_RUN_STATUSES;
const CANCELLABLE_ATTEMPT_STATUSES = NON_FINAL_ATTEMPT_STATUSES;

const CRASHABLE_RUN_STATUSES = NON_FINAL_RUN_STATUSES;
const CRASHABLE_ATTEMPT_STATUSES = NON_FINAL_ATTEMPT_STATUSES;

const FAILABLE_RUN_STATUSES = NON_FINAL_RUN_STATUSES;

const FREEZABLE_RUN_STATUSES: TaskRunStatus[] = ["EXECUTING", "RETRYING_AFTER_FAILURE"];
const FREEZABLE_ATTEMPT_STATUSES: TaskRunAttemptStatus[] = ["EXECUTING", "FAILED"];

const RESTORABLE_RUN_STATUSES: TaskRunStatus[] = ["WAITING_TO_RESUME"];
const RESTORABLE_ATTEMPT_STATUSES: TaskRunAttemptStatus[] = ["PAUSED"];

export function isFinalRunStatus(status: TaskRunStatus): boolean {
  return FINAL_RUN_STATUSES.includes(status);
}
export function isFinalAttemptStatus(status: TaskRunAttemptStatus): boolean {
  return FINAL_ATTEMPT_STATUSES.includes(status);
}

export function isFailedRunStatus(status: TaskRunStatus): boolean {
  return FAILED_RUN_STATUSES.includes(status);
}

function isFatalRunStatus(status: TaskRunStatus): boolean {
  return FATAL_RUN_STATUSES.includes(status);
}

export function isCancellableRunStatus(status: TaskRunStatus): boolean {
  return CANCELLABLE_RUN_STATUSES.includes(status);
}
function isCancellableAttemptStatus(status: TaskRunAttemptStatus): boolean {
  return CANCELLABLE_ATTEMPT_STATUSES.includes(status);
}

export function isPendingRunStatus(status: TaskRunStatus): boolean {
  return PENDING_STATUSES.includes(status);
}

function isCrashableRunStatus(status: TaskRunStatus): boolean {
  return CRASHABLE_RUN_STATUSES.includes(status);
}
function isCrashableAttemptStatus(status: TaskRunAttemptStatus): boolean {
  return CRASHABLE_ATTEMPT_STATUSES.includes(status);
}

function isFailableRunStatus(status: TaskRunStatus): boolean {
  return FAILABLE_RUN_STATUSES.includes(status);
}

function isFreezableRunStatus(status: TaskRunStatus): boolean {
  return FREEZABLE_RUN_STATUSES.includes(status);
}
function isFreezableAttemptStatus(status: TaskRunAttemptStatus): boolean {
  return FREEZABLE_ATTEMPT_STATUSES.includes(status);
}

function isRestorableRunStatus(status: TaskRunStatus): boolean {
  return RESTORABLE_RUN_STATUSES.includes(status);
}
function isRestorableAttemptStatus(status: TaskRunAttemptStatus): boolean {
  return RESTORABLE_ATTEMPT_STATUSES.includes(status);
}

export function shouldIdempotencyKeyBeCleared(status: TaskRunStatus): boolean {
  return isFailedRunStatus(status) || status === "EXPIRED";
}
