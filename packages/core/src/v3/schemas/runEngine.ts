import { z } from "zod";
import { MachinePreset } from "./common.js";
import { EnvironmentType } from "./schemas.js";

export const TaskRunExecutionStatus = {
  RUN_CREATED: "RUN_CREATED",
  QUEUED: "QUEUED",
  PENDING_EXECUTING: "PENDING_EXECUTING",
  EXECUTING: "EXECUTING",
  EXECUTING_WITH_WAITPOINTS: "EXECUTING_WITH_WAITPOINTS",
  BLOCKED_BY_WAITPOINTS: "BLOCKED_BY_WAITPOINTS",
  PENDING_CANCEL: "PENDING_CANCEL",
  FINISHED: "FINISHED",
} as const;

export type TaskRunExecutionStatus =
  (typeof TaskRunExecutionStatus)[keyof typeof TaskRunExecutionStatus];

export const TaskRunStatus = {
  DELAYED: "DELAYED",
  PENDING: "PENDING",
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
  EXPIRED: "EXPIRED",
  TIMED_OUT: "TIMED_OUT",
} as const;

export type TaskRunStatus = (typeof TaskRunStatus)[keyof typeof TaskRunStatus];

export const WaitpointType = {
  RUN: "RUN",
  DATETIME: "DATETIME",
  MANUAL: "MANUAL",
} as const;

export type WaitpointType = (typeof WaitpointType)[keyof typeof WaitpointType];

const CompletedWaitpoint = z.object({
  id: z.string(),
  type: z.enum(Object.values(WaitpointType) as [WaitpointType]),
  completedAt: z.coerce.date(),
  idempotencyKey: z.string().optional(),
  /** For type === "RUN" */
  completedByTaskRunId: z.string().optional(),
  /** For type === "DATETIME" */
  completedAfter: z.coerce.date().optional(),
  output: z.string().optional(),
  outputType: z.string().optional(),
  outputIsError: z.boolean(),
});

/** This is sent to a Worker when a run is dequeued (a new run or continuing run) */
export const DequeuedMessage = z.object({
  version: z.literal("1"),
  snapshot: z.object({
    id: z.string(),
  }),
  image: z.string().optional(),
  checkpoint: z
    .object({
      id: z.string(),
      type: z.string(),
      location: z.string(),
      reason: z.string().nullish(),
    })
    .optional(),
  completedWaitpoints: z.array(CompletedWaitpoint),
  backgroundWorker: z.object({
    id: z.string(),
    version: z.string(),
  }),
  run: z.object({
    id: z.string(),
    friendlyId: z.string(),
    isTest: z.boolean(),
    machine: MachinePreset,
    attemptNumber: z.number(),
    masterQueue: z.string(),
    traceContext: z.record(z.unknown()),
  }),
  environment: z.object({
    id: z.string(),
    type: EnvironmentType,
  }),
  organization: z.object({
    id: z.string(),
  }),
  project: z.object({
    id: z.string(),
  }),
});
export type DequeuedMessage = z.infer<typeof DequeuedMessage>;

export const RunExecutionData = z.object({
  version: z.literal("1"),
  snapshot: z.object({
    id: z.string(),
    executionStatus: z.enum(Object.values(TaskRunExecutionStatus) as [TaskRunExecutionStatus]),
    description: z.string(),
  }),
  run: z.object({
    id: z.string(),
    status: z.enum(Object.values(TaskRunStatus) as [TaskRunStatus]),
    attemptNumber: z.number().optional(),
  }),
  checkpoint: z
    .object({
      id: z.string(),
      type: z.string(),
      location: z.string(),
      imageRef: z.string(),
      reason: z.string().optional(),
    })
    .optional(),
  completedWaitpoints: z.array(CompletedWaitpoint),
});

export type RunExecutionData = z.infer<typeof RunExecutionData>;

export const CompleteAttemptResult = z.enum(["COMPLETED", "RETRY_QUEUED", "RETRY_IMMEDIATELY"]);
export type CompleteAttemptResult = z.infer<typeof CompleteAttemptResult>;
