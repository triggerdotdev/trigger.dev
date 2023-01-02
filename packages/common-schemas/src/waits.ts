import { z } from "zod";

export const DelaySchema = z.object({
  type: z.literal("DELAY"),
  seconds: z.number().optional(),
  minutes: z.number().optional(),
  hours: z.number().optional(),
  days: z.number().optional(),
});

export const ScheduledForSchema = z.object({
  type: z.literal("SCHEDULE_FOR"),
  scheduledFor: z.string().datetime(),
});

export const WaitSchema = z.discriminatedUnion("type", [
  DelaySchema,
  ScheduledForSchema,
]);
