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
  repairSnapshot: {
    schema: z.object({
      runId: z.string(),
      snapshotId: z.string(),
      executionStatus: z.string(),
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
      /**
       * Bounded retry counter used by {@link PendingVersionSystem} to cover
       * ClickHouse replication lag. The first scheduling has no attempt;
       * if the lookup returns zero candidates, the system reschedules
       * itself once with `attempt = 1`. Capped by
       * `pendingVersionLagMaxRetries` on `RunEngineOptions`.
       */
      attempt: z.number().int().nonnegative().optional(),
    }),
    visibilityTimeoutMs: 60_000,
  },
  expireParkedExternalDeploymentRun: {
    schema: z.object({
      runId: z.string(),
      externalDeploymentId: z.string(),
    }),
    visibilityTimeoutMs: 60_000,
  },
  tryCompleteBatch: {
    schema: z.object({
      batchId: z.string(),
    }),
    visibilityTimeoutMs: 30_000,
  },
  expireBatch: {
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
  sweepSnapshotOrphans: {
    schema: z.object({
      timestamp: z.number(),
      lastTimestamp: z.number().optional(),
      cron: z.string(),
    }),
    // The default budget plus two hours, so it stays strictly above the runner's lock TTL
    // (budget plus one hour). Ordered that way, a lock outlives the delivery it belongs to.
    visibilityTimeoutMs: 18_000_000,
    cron: "0 */6 * * *",
    jitterInMs: 60_000,
    // Load-bearing. A throw takes the dead-letter path, which also reschedules, so the cron chain
    // survives a failed pass. With retries it would not behave that way.
    retry: { maxAttempts: 1 },
  },
};
