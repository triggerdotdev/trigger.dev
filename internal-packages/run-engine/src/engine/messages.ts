import { EnvironmentType, MachinePreset } from "@trigger.dev/core/v3";
import { TaskRunExecutionStatus, TaskRunStatus, WaitpointType } from "@trigger.dev/database";
import { z } from "zod";

//todo it will need to move into core because the Worker will need to use these
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

/** This is sent to a Worker when a run is dequeued (a new run or continuing run) */
const DequeuedMessage = z.object({
  version: z.literal("1"),
  execution: z.object({
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
