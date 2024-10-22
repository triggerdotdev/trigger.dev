import { EnvironmentType, MachinePreset } from "@trigger.dev/core/v3";
import { TaskRunExecutionStatus, TaskRunStatus, WaitpointType } from "@trigger.dev/database";
import { z } from "zod";

//todo it will need to move into core because the Worker will need to use these

/** This is sent to a Worker when a run is dequeued (a new run or continuing run) */
const CreatedAttemptMessage = z.object({
  action: z.literal("SCHEDULE_RUN"),
  // The payload allows us to a discriminated union with the version
  payload: z.object({
    version: z.literal("1"),
    execution: z.object({
      id: z.string(),
      status: z.literal("PENDING_EXECUTING"),
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
  }),
});
export type CreatedAttemptMessage = z.infer<typeof CreatedAttemptMessage>;

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
});

export const RunExecutionData = z.object({
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
  completedWaitpoints: z.array(CompletedWaitpoint).optional(),
});

export type RunExecutionData = z.infer<typeof RunExecutionData>;
