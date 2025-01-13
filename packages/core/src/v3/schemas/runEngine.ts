import { z } from "zod";
import { MachinePreset, TaskRunExecution } from "./common.js";
import { EnvironmentType } from "./schemas.js";
import type * as DB_TYPES from "@trigger.dev/database";

type Enum<T extends string> = { [K in T]: K };

export const TaskRunExecutionStatus = {
  RUN_CREATED: "RUN_CREATED",
  QUEUED: "QUEUED",
  PENDING_EXECUTING: "PENDING_EXECUTING",
  EXECUTING: "EXECUTING",
  EXECUTING_WITH_WAITPOINTS: "EXECUTING_WITH_WAITPOINTS",
  BLOCKED_BY_WAITPOINTS: "BLOCKED_BY_WAITPOINTS",
  PENDING_CANCEL: "PENDING_CANCEL",
  FINISHED: "FINISHED",
} satisfies Enum<DB_TYPES.TaskRunExecutionStatus>;

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
} satisfies Enum<DB_TYPES.TaskRunStatus>;

export type TaskRunStatus = (typeof TaskRunStatus)[keyof typeof TaskRunStatus];

export const WaitpointType = {
  RUN: "RUN",
  DATETIME: "DATETIME",
  MANUAL: "MANUAL",
  BATCH: "BATCH",
} satisfies Enum<DB_TYPES.WaitpointType>;

export type WaitpointType = (typeof WaitpointType)[keyof typeof WaitpointType];

export const CompletedWaitpoint = z.object({
  id: z.string(),
  index: z.number().optional(),
  friendlyId: z.string(),
  type: z.enum(Object.values(WaitpointType) as [WaitpointType]),
  completedAt: z.coerce.date(),
  idempotencyKey: z.string().optional(),
  /** For type === "RUN" */
  completedByTaskRun: z
    .object({
      id: z.string(),
      friendlyId: z.string(),
      /** If the run has an associated batch */
      batch: z
        .object({
          id: z.string(),
          friendlyId: z.string(),
        })
        .optional(),
    })
    .optional(),
  /** For type === "DATETIME" */
  completedAfter: z.coerce.date().optional(),
  /** For type === "BATCH" */
  completedByBatch: z
    .object({
      id: z.string(),
      friendlyId: z.string(),
    })
    .optional(),
  output: z.string().optional(),
  outputType: z.string().optional(),
  outputIsError: z.boolean(),
});

export type CompletedWaitpoint = z.infer<typeof CompletedWaitpoint>;

const ExecutionSnapshot = z.object({
  id: z.string(),
  friendlyId: z.string(),
  executionStatus: z.enum(Object.values(TaskRunExecutionStatus) as [TaskRunExecutionStatus]),
  description: z.string(),
});

const BaseRunMetadata = z.object({
  id: z.string(),
  friendlyId: z.string(),
  status: z.enum(Object.values(TaskRunStatus) as [TaskRunStatus]),
  attemptNumber: z.number().nullish(),
});

export const ExecutionResult = z.object({
  snapshot: ExecutionSnapshot,
  run: BaseRunMetadata,
});

export type ExecutionResult = z.infer<typeof ExecutionResult>;

/** This is sent to a Worker when a run is dequeued (a new run or continuing run) */
export const DequeuedMessage = z.object({
  version: z.literal("1"),
  snapshot: ExecutionSnapshot,
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
    friendlyId: z.string(),
    version: z.string(),
  }),
  deployment: z.object({
    id: z.string().optional(),
    friendlyId: z.string().optional(),
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

/** The response to the Worker when starting an attempt */
export const StartRunAttemptResult = ExecutionResult.and(
  z.object({
    execution: TaskRunExecution,
  })
);
export type StartRunAttemptResult = z.infer<typeof StartRunAttemptResult>;

/** The response to the Worker when completing an attempt */
const CompleteAttemptStatus = z.enum([
  "RUN_FINISHED",
  "RUN_PENDING_CANCEL",
  "RETRY_QUEUED",
  "RETRY_IMMEDIATELY",
]);
export type CompleteAttemptStatus = z.infer<typeof CompleteAttemptStatus>;

export const CompleteRunAttemptResult = z
  .object({
    attemptStatus: CompleteAttemptStatus,
  })
  .and(ExecutionResult);
export type CompleteRunAttemptResult = z.infer<typeof CompleteRunAttemptResult>;

/** The response when a Worker asks for the latest execution state */
export const RunExecutionData = z.object({
  version: z.literal("1"),
  snapshot: ExecutionSnapshot,
  run: BaseRunMetadata,
  batch: z
    .object({
      id: z.string(),
      friendlyId: z.string(),
    })
    .optional(),
  checkpoint: z
    .object({
      id: z.string(),
      friendlyId: z.string(),
      type: z.string(),
      location: z.string(),
      imageRef: z.string(),
      reason: z.string().optional(),
    })
    .optional(),
  completedWaitpoints: z.array(CompletedWaitpoint),
});
export type RunExecutionData = z.infer<typeof RunExecutionData>;

export const WaitForDurationResult = z
  .object({
    /**
        If you pass an idempotencyKey, you may actually not need to wait.
        Use this date to determine when to continue.
    */
    waitUntil: z.coerce.date(),
    waitpoint: z.object({
      id: z.string(),
    }),
  })
  .and(ExecutionResult);
export type WaitForDurationResult = z.infer<typeof WaitForDurationResult>;
