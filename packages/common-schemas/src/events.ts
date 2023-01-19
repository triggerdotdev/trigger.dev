import { z } from "zod";
import { JsonSchema, SerializableJsonSchema } from "./json";

export const CustomEventSchema = z.object({
  name: z.string(),
  payload: JsonSchema,
  context: JsonSchema.optional(),
  timestamp: z.string().datetime().optional(),
});

export const SerializableCustomEventSchema = z.object({
  name: z.string(),
  payload: SerializableJsonSchema,
  context: SerializableJsonSchema.optional(),
  timestamp: z.string().datetime().optional(),
});

const EventMatcherSchema = z.union([
  z.array(z.string()),
  z.array(z.number()),
  z.array(z.boolean()),
]);
type EventMatcher = z.infer<typeof EventMatcherSchema>;

export type EventFilter = { [key: string]: EventMatcher | EventFilter };

export const EventFilterSchema: z.ZodType<EventFilter> = z.lazy(() =>
  z.record(z.union([EventMatcherSchema, EventFilterSchema]))
);

export const ScheduledEventPayloadSchema = z.object({
  scheduledTime: z.coerce.date(),
});

export type ScheduledEventPayload = z.infer<typeof ScheduledEventPayloadSchema>;

export const ScheduleSourceRateSchema = z.object({
  rateOf: z.union([
    z.object({
      minutes: z.number().min(1).max(1440).int(),
    }),
    z.object({
      hours: z.number().min(1).max(720).int(),
    }),
    z.object({
      days: z.number().min(1).max(365).int(),
    }),
  ]),
});

export type ScheduleSourceRate = z.infer<typeof ScheduleSourceRateSchema>;

export const ScheduleSourceCronSchema = z.object({
  cron: z.string(),
});

export type ScheduleSourceCron = z.infer<typeof ScheduleSourceCronSchema>;

export const ScheduleSourceSchema = z.union([
  ScheduleSourceRateSchema,
  ScheduleSourceCronSchema,
]);

export type ScheduleSource = z.infer<typeof ScheduleSourceSchema>;
