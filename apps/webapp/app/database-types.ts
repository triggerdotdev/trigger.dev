// There's a weird issue with importing values from the prisma client
// when using Remix Vite + pnpm + prisma
// As long as they're only used as types it's ok
// Import types here and validate hardcoded enums

import type {
  BatchTaskRunItemStatus as BatchTaskRunItemStatusType,
  TaskRunAttemptStatus as TaskRunAttemptStatusType,
  TaskRunStatus as TaskRunStatusType,
  JobRunStatus as JobRunStatusType,
  RuntimeEnvironmentType as RuntimeEnvironmentTypeType,
} from "@trigger.dev/database";

export const BatchTaskRunItemStatus = {
  PENDING: "PENDING",
  FAILED: "FAILED",
  CANCELED: "CANCELED",
  COMPLETED: "COMPLETED",
} as const satisfies Record<BatchTaskRunItemStatusType, BatchTaskRunItemStatusType>;

export const TaskRunAttemptStatus = {
  PENDING: "PENDING",
  EXECUTING: "EXECUTING",
  PAUSED: "PAUSED",
  FAILED: "FAILED",
  CANCELED: "CANCELED",
  COMPLETED: "COMPLETED",
} as const satisfies Record<TaskRunAttemptStatusType, TaskRunAttemptStatusType>;

export const TaskRunStatus = {
  PENDING: "PENDING",
  PENDING_VERSION: "PENDING_VERSION",
  WAITING_FOR_DEPLOY: "WAITING_FOR_DEPLOY",
  EXECUTING: "EXECUTING",
  WAITING_TO_RESUME: "WAITING_TO_RESUME",
  RETRYING_AFTER_FAILURE: "RETRYING_AFTER_FAILURE",
  PAUSED: "PAUSED",
  CANCELED: "CANCELED",
  INTERRUPTED: "INTERRUPTED",
  COMPLETED_SUCCESSFULLY: "COMPLETED_SUCCESSFULLY",
  COMPLETED_WITH_ERRORS: "COMPLETED_WITH_ERRORS",
  SYSTEM_FAILURE: "SYSTEM_FAILURE",
  CRASHED: "CRASHED",
  DELAYED: "DELAYED",
  EXPIRED: "EXPIRED",
  TIMED_OUT: "TIMED_OUT",
} as const satisfies Record<TaskRunStatusType, TaskRunStatusType>;

export const JobRunStatus = {
  PENDING: "PENDING",
  QUEUED: "QUEUED",
  WAITING_ON_CONNECTIONS: "WAITING_ON_CONNECTIONS",
  PREPROCESSING: "PREPROCESSING",
  STARTED: "STARTED",
  EXECUTING: "EXECUTING",
  WAITING_TO_CONTINUE: "WAITING_TO_CONTINUE",
  WAITING_TO_EXECUTE: "WAITING_TO_EXECUTE",
  SUCCESS: "SUCCESS",
  FAILURE: "FAILURE",
  TIMED_OUT: "TIMED_OUT",
  ABORTED: "ABORTED",
  CANCELED: "CANCELED",
  UNRESOLVED_AUTH: "UNRESOLVED_AUTH",
  INVALID_PAYLOAD: "INVALID_PAYLOAD",
} as const satisfies Record<JobRunStatusType, JobRunStatusType>;

export const RuntimeEnvironmentType = {
  PRODUCTION: "PRODUCTION",
  STAGING: "STAGING",
  DEVELOPMENT: "DEVELOPMENT",
  PREVIEW: "PREVIEW",
} as const satisfies Record<RuntimeEnvironmentTypeType, RuntimeEnvironmentTypeType>;

export function isTaskRunAttemptStatus(value: string): value is keyof typeof TaskRunAttemptStatus {
  return Object.values(TaskRunAttemptStatus).includes(value as keyof typeof TaskRunAttemptStatus);
}

export function isTaskRunStatus(value: string): value is keyof typeof TaskRunStatus {
  return Object.values(TaskRunStatus).includes(value as keyof typeof TaskRunStatus);
}
