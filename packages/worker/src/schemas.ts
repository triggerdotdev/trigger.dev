import { z } from "zod";
import {
  CompleteRunAttemptResult,
  DequeuedMessage,
  StartRunAttemptResult,
  TaskRunExecutionResult,
} from "@trigger.dev/core/v3";

// Worker
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
});
export type WorkerApiConnectResponseBody = z.infer<typeof WorkerApiConnectResponseBody>;

export const WorkerApiDequeueResponseBody = DequeuedMessage.array();
export type WorkerApiDequeueResponseBody = z.infer<typeof WorkerApiDequeueResponseBody>;

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

// Workload
export const WorkloadHeartbeatRequestBody = z.object({
  cpu: z.number(),
  memory: z.number(),
});
export type WorkloadHeartbeatRequestBody = z.infer<typeof WorkloadHeartbeatRequestBody>;

export const WorkloadHeartbeatResponseBody = WorkerApiHeartbeatResponseBody;
export type WorkloadHeartbeatResponseBody = z.infer<typeof WorkloadHeartbeatResponseBody>;

export const WorkloadRunAttemptCompleteRequestBody = WorkerApiRunAttemptCompleteRequestBody;
export type WorkloadRunAttemptCompleteRequestBody = z.infer<
  typeof WorkloadRunAttemptCompleteRequestBody
>;

export const WorkloadRunAttemptCompleteResponseBody = WorkerApiRunAttemptCompleteResponseBody;
export type WorkloadRunAttemptCompleteResponseBody = z.infer<
  typeof WorkloadRunAttemptCompleteResponseBody
>;

export const WorkloadRunAttemptStartResponseBody = WorkerApiRunAttemptStartResponseBody;
export type WorkloadRunAttemptStartResponseBody = z.infer<
  typeof WorkloadRunAttemptStartResponseBody
>;
