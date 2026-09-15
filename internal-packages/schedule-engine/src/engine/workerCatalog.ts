import { z } from "zod";

export const scheduleWorkerCatalog = {
  "schedule.triggerScheduledTask": {
    schema: z.object({
      instanceId: z.string(),
      // The nominal cron occurrence. Keep this field name for compatibility
      // with jobs enqueued before effective schedule times were introduced.
      exactScheduleTime: z.coerce.date(),
      // Optional for compatibility with in-flight jobs. Missing means the
      // effective time is the nominal exactScheduleTime.
      effectiveScheduleTime: z.coerce.date().optional(),
      // Optional for backward compat with in-flight jobs enqueued by older
      // engines. After deploy, every newly-enqueued job populates this with
      // the just-fired schedule time so the next dequeue can report
      // payload.lastTimestamp accurately without a DB round-trip.
      lastScheduleTime: z.coerce.date().optional(),
    }),
    visibilityTimeoutMs: 60_000,
    retry: {
      maxAttempts: 5,
    },
  },
};
