import { z } from "zod";

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

export const EventRuleSchema = z.object({
  event: z.string(),
  source: z.string(),
  payload: EventFilterSchema.optional(),
  context: EventFilterSchema.optional(),
});

export type EventRule = z.infer<typeof EventRuleSchema>;
