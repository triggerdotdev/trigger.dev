import { z } from "zod/v4";
import { WeightedWorkerQueueSubscriptions } from "../workerQueue.js";
import { discriminatedUnion } from "../../utils/zod.js";
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
import { RunTokenHeartbeatReport } from "../runTokenRefresh.js";

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

export const WorkerApiSuspendRunRequestBody = discriminatedUnion("success", [
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

export const WorkerApiRunRestoreOutcomeRequestBody = z.object({
  // `fallback` requeues a run that has not started onto the worker queue the platform falls back to.
  outcome: z.enum(["requeue", "fail", "fallback"]),
  reason: z.string().max(256),
  // Matches the cap the engine applies to a run error's message.
  message: z
    .string()
    .max(16 * 1024)
    .optional(),
});
export type WorkerApiRunRestoreOutcomeRequestBody = z.infer<
  typeof WorkerApiRunRestoreOutcomeRequestBody
>;

export const WorkerApiRunRestoreOutcomeResponseBody = z.object({
  ok: z.literal(true),
});
export type WorkerApiRunRestoreOutcomeResponseBody = z.infer<
  typeof WorkerApiRunRestoreOutcomeResponseBody
>;

export const WorkerApiConnectRequestBody = z.object({
  metadata: z.record(z.string(), z.any()),
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

export const WorkerQueueClass = z.enum(["default", "scheduled"]);
export type WorkerQueueClass = z.infer<typeof WorkerQueueClass>;

export const WorkerApiDequeueRequestBody = z
  .object({
    maxResources: MachineResources.optional(),
    /** Legacy selection. Absent or "default" targets the worker group's base queue. */
    queueClass: WorkerQueueClass.optional(),
    /** V2 selection. The server derives region from the authenticated worker. */
    subscriptions: WeightedWorkerQueueSubscriptions.optional(),
  })
  .refine((body) => body.queueClass === undefined || body.subscriptions === undefined, {
    message: "queueClass and subscriptions are mutually exclusive",
    path: ["subscriptions"],
  });
export type WorkerApiDequeueRequestBody = z.infer<typeof WorkerApiDequeueRequestBody>;

export const WorkerApiDequeueResponseBody = DequeuedMessage.array();
export type WorkerApiDequeueResponseBody = z.infer<typeof WorkerApiDequeueResponseBody>;

export const WorkerApiRunHeartbeatRequestBody = z.object({
  cpu: z.number().optional(),
  memory: z.number().optional(),
  // A malformed report must never fail the heartbeat itself.
  runToken: RunTokenHeartbeatReport.optional().catch(undefined),
});
export type WorkerApiRunHeartbeatRequestBody = z.infer<typeof WorkerApiRunHeartbeatRequestBody>;

export const WorkerApiRunHeartbeatResponseBody = z.object({
  ok: z.literal(true),
  /** A replacement TRIGGER_RUN_TOKEN, only when the runner's reported token is due for refresh. */
  runToken: z.string().optional(),
});
export type WorkerApiRunHeartbeatResponseBody = z.infer<typeof WorkerApiRunHeartbeatResponseBody>;

export const WorkerApiRunAttemptStartRequestBody = z.object({
  isWarmStart: z.boolean().optional(),
  // Set by the supervisor, not the runner. A value this webapp cannot accept drops the stamp, never the attempt.
  workerCell: z.string().max(64).optional().catch(undefined),
  workerLane: z.string().max(32).optional().catch(undefined),
  /** Set by runners that report and install run-token refreshes, so the attempt can get a short-lived token. */
  supportsRunTokenRefresh: z.boolean().optional().catch(undefined),
});
export type WorkerApiRunAttemptStartRequestBody = z.infer<
  typeof WorkerApiRunAttemptStartRequestBody
>;

export const WorkerApiRunAttemptStartResponseBody = StartRunAttemptResult.and(
  z.object({
    envVars: z.record(z.string(), z.string()),
  })
);
export type WorkerApiRunAttemptStartResponseBody = z.infer<
  typeof WorkerApiRunAttemptStartResponseBody
>;

export const WorkerApiRunAttemptCompleteRequestBody = z.object({
  completion: TaskRunExecutionResult,
  /** Queue any retry for a new runner instead of retrying on this one, e.g. when it was killed. */
  forceRequeue: z.boolean().optional(),
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

export const DebugLogPropertiesValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string().nullish()),
  z.array(z.number().nullish()),
  z.array(z.boolean().nullish()),
]);

export const DebugLogProperties = z.record(z.string(), DebugLogPropertiesValue.optional());
export type DebugLogProperties = z.infer<typeof DebugLogProperties>;

export const DebugLogPropertiesInput = z.record(z.string(), z.unknown());
export type DebugLogPropertiesInput = z.infer<typeof DebugLogPropertiesInput>;

export const WorkerApiDebugLogBodyInput = z.object({
  time: z.coerce.date(),
  message: z.string(),
  properties: DebugLogPropertiesInput.optional(),
});
export type WorkerApiDebugLogBodyInput = z.infer<typeof WorkerApiDebugLogBodyInput>;

export const WorkerApiDebugLogBody = z.object({
  time: z.coerce.date(),
  message: z.string(),
  properties: DebugLogProperties.optional(),
});
export type WorkerApiDebugLogBody = z.infer<typeof WorkerApiDebugLogBody>;

export const WorkerApiSuspendCompletionResponseBody = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});
export type WorkerApiSuspendCompletionResponseBody = z.infer<
  typeof WorkerApiSuspendCompletionResponseBody
>;

export const WorkerApiRunSnapshotsSinceResponseBody = z.object({
  snapshots: z.array(RunExecutionData),
});
export type WorkerApiRunSnapshotsSinceResponseBody = z.infer<
  typeof WorkerApiRunSnapshotsSinceResponseBody
>;
