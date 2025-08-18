import { z } from "zod";
import { Enum, MachinePreset, RuntimeEnvironmentType, TaskRunExecution } from "./common.js";
import { EnvironmentType } from "./schemas.js";
import type * as DB_TYPES from "@trigger.dev/database";

export const TaskRunExecutionStatus = {
  RUN_CREATED: "RUN_CREATED",
  QUEUED: "QUEUED",
  QUEUED_EXECUTING: "QUEUED_EXECUTING",
  PENDING_EXECUTING: "PENDING_EXECUTING",
  EXECUTING: "EXECUTING",
  EXECUTING_WITH_WAITPOINTS: "EXECUTING_WITH_WAITPOINTS",
  SUSPENDED: "SUSPENDED",
  PENDING_CANCEL: "PENDING_CANCEL",
  FINISHED: "FINISHED",
} satisfies Enum<DB_TYPES.TaskRunExecutionStatus>;

export type TaskRunExecutionStatus =
  (typeof TaskRunExecutionStatus)[keyof typeof TaskRunExecutionStatus];

export const TaskRunStatus = {
  DELAYED: "DELAYED",
  PENDING: "PENDING",
  PENDING_VERSION: "PENDING_VERSION",
  WAITING_FOR_DEPLOY: "WAITING_FOR_DEPLOY",
  DEQUEUED: "DEQUEUED",
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

const WaitpointStatusValues = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
} satisfies Enum<DB_TYPES.WaitpointStatus>;
export const WaitpointStatus = z.enum(
  Object.values(WaitpointStatusValues) as [DB_TYPES.WaitpointStatus]
);
export type WaitpointStatus = z.infer<typeof WaitpointStatus>;

export type TaskEventEnvironment = {
  id: string;
  type: RuntimeEnvironmentType;
  organizationId: string;
  projectId: string;
  project: {
    externalRef: string;
  };
};

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
  createdAt: z.coerce.date(),
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

export const CheckpointTypeEnum = {
  DOCKER: "DOCKER",
  KUBERNETES: "KUBERNETES",
} satisfies Enum<DB_TYPES.CheckpointType>;
export type CheckpointTypeEnum = (typeof CheckpointTypeEnum)[keyof typeof CheckpointTypeEnum];

export const CheckpointType = z.enum(Object.values(CheckpointTypeEnum) as [CheckpointTypeEnum]);
export type CheckpointType = z.infer<typeof CheckpointType>;

export const CheckpointInput = z.object({
  type: CheckpointType,
  location: z.string(),
  imageRef: z.string().nullish(),
  reason: z.string().nullish(),
});

export type CheckpointInput = z.infer<typeof CheckpointInput>;

export const TaskRunCheckpoint = CheckpointInput.merge(
  z.object({
    id: z.string(),
    friendlyId: z.string(),
  })
);

export type TaskRunCheckpoint = z.infer<typeof TaskRunCheckpoint>;

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
  checkpoint: TaskRunCheckpoint.optional(),
  completedWaitpoints: z.array(CompletedWaitpoint),
});
export type RunExecutionData = z.infer<typeof RunExecutionData>;

export const CreateCheckpointResult = z.discriminatedUnion("ok", [
  z
    .object({
      ok: z.literal(true),
      checkpoint: TaskRunCheckpoint,
    })
    .merge(ExecutionResult),
  z.object({
    ok: z.literal(false),
    error: z.string(),
  }),
]);

export type CreateCheckpointResult = z.infer<typeof CreateCheckpointResult>;

export const MachineResources = z.object({
  cpu: z.number(),
  memory: z.number(),
});
export type MachineResources = z.infer<typeof MachineResources>;

export const DequeueMessageCheckpoint = z.object({
  id: z.string(),
  type: CheckpointType,
  location: z.string(),
  imageRef: z.string().nullish(),
  reason: z.string().nullish(),
});
export type DequeueMessageCheckpoint = z.infer<typeof DequeueMessageCheckpoint>;

export const PlacementTag = z.object({
  key: z.string(),
  values: z.array(z.string()).optional(),
});
export type PlacementTag = z.infer<typeof PlacementTag>;

/** This is sent to a Worker when a run is dequeued (a new run or continuing run) */
export const DequeuedMessage = z.object({
  version: z.literal("1"),
  snapshot: ExecutionSnapshot,
  dequeuedAt: z.coerce.date(),
  image: z.string().optional(),
  checkpoint: DequeueMessageCheckpoint.optional(),
  completedWaitpoints: z.array(CompletedWaitpoint),
  backgroundWorker: z.object({
    id: z.string(),
    friendlyId: z.string(),
    version: z.string(),
  }),
  deployment: z.object({
    id: z.string().optional(),
    friendlyId: z.string().optional(),
    imagePlatform: z.string().optional(),
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
  placementTags: z.array(PlacementTag).optional(),
});
export type DequeuedMessage = z.infer<typeof DequeuedMessage>;
