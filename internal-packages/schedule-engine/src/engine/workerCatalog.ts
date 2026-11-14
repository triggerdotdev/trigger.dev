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
    // Longer than a short Postgres outage (~30–60s). With the redis-worker
    // defaults this budget covers roughly 9–10 minutes before DLQ, so a brief
    // DB blip delays a tick instead of permanently stopping the schedule chain.
    // See https://github.com/triggerdotdev/trigger.dev/issues/5120
    retry: {
      maxAttempts: 15,
      maxTimeoutInMs: 60_000,
    },
  },
};
