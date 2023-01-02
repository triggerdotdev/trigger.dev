import { z } from "zod";

export const DelaySchema = z.object({
  type: z.literal("DELAY"),
  seconds: z.number().optional(),
  minutes: z.number().optional(),
  hours: z.number().optional(),
  days: z.number().optional(),
});

export type Delay = z.infer<typeof DelaySchema>;

export const ScheduledForSchema = z.object({
  type: z.literal("SCHEDULE_FOR"),
  scheduledFor: z.string().datetime(),
});

export type Scheduled = z.infer<typeof ScheduledForSchema>;

export const WaitSchema = z.discriminatedUnion("type", [
  DelaySchema,
  ScheduledForSchema,
]);
