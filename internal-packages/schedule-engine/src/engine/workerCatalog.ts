import { z } from "zod";

export const scheduleWorkerCatalog = {
  "schedule.triggerScheduledTask": {
    schema: z.object({
      instanceId: z.string(),
      exactScheduleTime: z.coerce.date(),
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
