import { z } from "zod";

export const scheduleWorkerCatalog = {
  "schedule.triggerScheduledTask": {
    schema: z.object({
      instanceId: z.string(),
      exactScheduleTime: z.coerce.date(),
    }),
    visibilityTimeoutMs: 60_000,
    retry: {
      maxAttempts: 5,
    },
  },
};
