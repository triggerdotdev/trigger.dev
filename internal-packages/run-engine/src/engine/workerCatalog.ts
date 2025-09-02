import { z } from "zod";

export const workerCatalog = {
  finishWaitpoint: {
    schema: z.object({
      waitpointId: z.string(),
      error: z.string().optional(),
    }),
    visibilityTimeoutMs: 30_000,
  },
  heartbeatSnapshot: {
    schema: z.object({
      runId: z.string(),
      snapshotId: z.string(),
      restartAttempt: z.number().optional(),
    }),
    visibilityTimeoutMs: 30_000,
  },
  expireRun: {
    schema: z.object({
      runId: z.string(),
    }),
    visibilityTimeoutMs: 30_000,
  },
  cancelRun: {
    schema: z.object({
      runId: z.string(),
      completedAt: z.coerce.date(),
      reason: z.string().optional(),
    }),
    visibilityTimeoutMs: 30_000,
  },
  queueRunsPendingVersion: {
    schema: z.object({
      backgroundWorkerId: z.string(),
    }),
    visibilityTimeoutMs: 60_000,
  },
  tryCompleteBatch: {
    schema: z.object({
      batchId: z.string(),
    }),
    visibilityTimeoutMs: 30_000,
  },
  continueRunIfUnblocked: {
    schema: z.object({
      runId: z.string(),
    }),
    visibilityTimeoutMs: 30_000,
  },
  enqueueDelayedRun: {
    schema: z.object({
      runId: z.string(),
    }),
    visibilityTimeoutMs: 30_000,
  },
};
