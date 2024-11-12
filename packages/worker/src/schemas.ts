import { z } from "zod";
import {
  CompleteAttemptResult,
  DequeuedMessage,
  TaskRunExecutionResult,
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

export const WorkerApiConnectResponseBody = z.object({
  ok: z.literal(true),
});
export type WorkerApiConnectResponseBody = z.infer<typeof WorkerApiConnectResponseBody>;

export const WorkerApiDequeueResponseBody = DequeuedMessage.array();
export type WorkerApiDequeueResponseBody = z.infer<typeof WorkerApiDequeueResponseBody>;

// Attempt start
export const WorkerApiRunAttemptStartResponseBody = z.object({
  run: z.any(),
  snapshot: z.any(),
  execution: z.any(),
});
export type WorkerApiRunAttemptStartResponseBody = z.infer<
  typeof WorkerApiRunAttemptStartResponseBody
>;

// Attempt completion
export const WorkerApiRunAttemptCompleteRequestBody = z.object({
  completion: TaskRunExecutionResult,
});
export type WorkerApiRunAttemptCompleteRequestBody = z.infer<
  typeof WorkerApiRunAttemptCompleteRequestBody
>;

export const WorkerApiRunAttemptCompleteResponseBody = z.object({
  result: CompleteAttemptResult,
});
export type WorkerApiRunAttemptCompleteResponseBody = z.infer<
  typeof WorkerApiRunAttemptCompleteResponseBody
>;
