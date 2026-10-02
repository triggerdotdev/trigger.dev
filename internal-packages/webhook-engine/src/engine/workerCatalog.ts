import { CronSchema, type WorkerCatalog } from "@trigger.dev/redis-worker";

export const webhookWorkerCatalog = {
  ensurePartitions: {
    schema: CronSchema,
    visibilityTimeoutMs: 60_000 * 5,
    cron: "17 3 * * *", // daily 03:17 default; overridable from options.partitions.ensureSchedule
    jitterInMs: 5 * 60_000, // up to 5m jitter; overridable from options.partitions.ensureJitterInMs
    retry: {
      maxAttempts: 1, // cron jobs do not retry (next tick re-runs)
    },
  },
} satisfies WorkerCatalog;
