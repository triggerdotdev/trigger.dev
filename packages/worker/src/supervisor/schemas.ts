import { z } from "zod";
import {
  CompleteRunAttemptResult,
  DequeuedMessage,
  RunExecutionData,
  StartRunAttemptResult,
  TaskRunExecutionResult,
  WaitForDurationResult,
} from "@trigger.dev/core/v3";

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

export const WorkerApiDequeueResponseBody = DequeuedMessage.array();
export type WorkerApiDequeueResponseBody = z.infer<typeof WorkerApiDequeueResponseBody>;

export const WorkerApiRunHeartbeatRequestBody = z.object({
  cpu: z.number(),
  memory: z.number(),
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

export const WorkerApiWaitForDurationRequestBody = z.object({
  date: z.coerce.date(),
});
export type WorkerApiWaitForDurationRequestBody = z.infer<
  typeof WorkerApiWaitForDurationRequestBody
>;

export const WorkerApiWaitForDurationResponseBody = WaitForDurationResult;
export type WorkerApiWaitForDurationResponseBody = z.infer<
  typeof WorkerApiWaitForDurationResponseBody
>;
