import { z } from "zod";

export const DelaySchema = z.object({
  type: z.literal("DELAY"),
  durationInMs: z.number(),
});

export const ScheduledForSchema = z.object({
  type: z.literal("SCHEDULE_FOR"),
  scheduledFor: z.string().datetime(),
});

export const WaitSchema = z.discriminatedUnion("type", [
  DelaySchema,
  ScheduledForSchema,
]);
