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
  /**
   * Write-ahead guard enqueued before every run-finish commit and acked when the
   * inline finalization side effects (waitpoint completion, parent unblock fan-out,
   * batch nudge) all succeed. It is the recovery mechanism for a finish whose side
   * effects were lost mid-flight, so its retry budget must outlive any database
   * outage: roughly five weeks at the capped backoff before it dead-letters, where
   * a genuinely poisoned item becomes visible and redrivable instead of retrying
   * silently forever.
   */
  ensureRunFinalized: {
    schema: z.object({
      runId: z.string(),
    }),
    visibilityTimeoutMs: 30_000,
    retry: {
      maxAttempts: 10_000,
      minTimeoutInMs: 1_000,
      maxTimeoutInMs: 300_000,
    },
  },
  enqueueDelayedRun: {
    schema: z.object({
      runId: z.string(),
    }),
    visibilityTimeoutMs: 30_000,
  },
};
