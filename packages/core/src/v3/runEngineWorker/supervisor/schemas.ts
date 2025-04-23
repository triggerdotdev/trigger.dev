import { z } from "zod";
import { TaskRunExecutionResult } from "../../schemas/common.js";
import {
  MachineResources,
  DequeuedMessage,
  StartRunAttemptResult,
  CompleteRunAttemptResult,
  RunExecutionData,
  CheckpointInput,
  ExecutionResult,
} from "../../schemas/runEngine.js";

export const WorkerApiHeartbeatRequestBody = z.object({
  cpu: z.object({
    used: z.number(),
    available: z.number(),
  }),
  memory: z.object({
    used: z.number(),
    available: z.number(),
  }),
  tasks: z.array(z.string()),
});
export type WorkerApiHeartbeatRequestBody = z.infer<typeof WorkerApiHeartbeatRequestBody>;

export const WorkerApiHeartbeatResponseBody = z.object({
  ok: z.literal(true),
});
export type WorkerApiHeartbeatResponseBody = z.infer<typeof WorkerApiHeartbeatResponseBody>;

export const WorkerApiSuspendRunRequestBody = z.discriminatedUnion("success", [
  z.object({
    success: z.literal(true),
    checkpoint: CheckpointInput,
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);
export type WorkerApiSuspendRunRequestBody = z.infer<typeof WorkerApiSuspendRunRequestBody>;

export const WorkerApiSuspendRunResponseBody = z.object({
  ok: z.literal(true),
});
export type WorkerApiSuspendRunResponseBody = z.infer<typeof WorkerApiSuspendRunResponseBody>;

export const WorkerApiContinueRunExecutionRequestBody = ExecutionResult;
export type WorkerApiContinueRunExecutionRequestBody = z.infer<
  typeof WorkerApiContinueRunExecutionRequestBody
>;

export const WorkerApiConnectRequestBody = z.object({
  metadata: z.record(z.any()),
});
export type WorkerApiConnectRequestBody = z.infer<typeof WorkerApiConnectRequestBody>;

export const WorkerApiConnectResponseBody = z.object({
  ok: z.literal(true),
  workerGroup: z.object({
    type: z.string(),
    name: z.string(),
  }),
});
export type WorkerApiConnectResponseBody = z.infer<typeof WorkerApiConnectResponseBody>;

export const WorkerApiDequeueRequestBody = z.object({
  maxResources: MachineResources.optional(),
  maxRunCount: z.number().optional(),
});
export type WorkerApiDequeueRequestBody = z.infer<typeof WorkerApiDequeueRequestBody>;

export const WorkerApiDequeueResponseBody = DequeuedMessage.array();
export type WorkerApiDequeueResponseBody = z.infer<typeof WorkerApiDequeueResponseBody>;

export const WorkerApiRunHeartbeatRequestBody = z.object({
  cpu: z.number().optional(),
  memory: z.number().optional(),
});
export type WorkerApiRunHeartbeatRequestBody = z.infer<typeof WorkerApiRunHeartbeatRequestBody>;

export const WorkerApiRunHeartbeatResponseBody = z.object({
  ok: z.literal(true),
});
export type WorkerApiRunHeartbeatResponseBody = z.infer<typeof WorkerApiRunHeartbeatResponseBody>;

export const WorkerApiRunAttemptStartRequestBody = z.object({
  isWarmStart: z.boolean().optional(),
});
export type WorkerApiRunAttemptStartRequestBody = z.infer<
  typeof WorkerApiRunAttemptStartRequestBody
>;

export const WorkerApiRunAttemptStartResponseBody = StartRunAttemptResult.and(
  z.object({
    envVars: z.record(z.string()),
  })
);
export type WorkerApiRunAttemptStartResponseBody = z.infer<
  typeof WorkerApiRunAttemptStartResponseBody
>;

export const WorkerApiRunAttemptCompleteRequestBody = z.object({
  completion: TaskRunExecutionResult,
});
export type WorkerApiRunAttemptCompleteRequestBody = z.infer<
  typeof WorkerApiRunAttemptCompleteRequestBody
>;

export const WorkerApiRunAttemptCompleteResponseBody = z.object({
  result: CompleteRunAttemptResult,
});
export type WorkerApiRunAttemptCompleteResponseBody = z.infer<
  typeof WorkerApiRunAttemptCompleteResponseBody
>;

export const WorkerApiRunLatestSnapshotResponseBody = z.object({
  execution: RunExecutionData,
});
export type WorkerApiRunLatestSnapshotResponseBody = z.infer<
  typeof WorkerApiRunLatestSnapshotResponseBody
>;

export const WorkerApiDequeueFromVersionResponseBody = DequeuedMessage.array();
export type WorkerApiDequeueFromVersionResponseBody = z.infer<
  typeof WorkerApiDequeueFromVersionResponseBody
>;

const AttributeValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string().nullable()),
  z.array(z.number().nullable()),
  z.array(z.boolean().nullable()),
]);

const Attributes = z.record(z.string(), AttributeValue.optional());

export const WorkerApiDebugLogBody = z.object({
  time: z.coerce.date(),
  message: z.string(),
  properties: Attributes.optional(),
});
export type WorkerApiDebugLogBody = z.infer<typeof WorkerApiDebugLogBody>;

export const WorkerApiSuspendCompletionResponseBody = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});
export type WorkerApiSuspendCompletionResponseBody = z.infer<
  typeof WorkerApiSuspendCompletionResponseBody
>;
