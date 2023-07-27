import { z } from "zod";

const EventMatcherSchema = z.union([
  /** Match against a string */
  z.array(z.string()),
  /** Match against a number */
  z.array(z.number()),
  /** Match against a boolean */
  z.array(z.boolean()),
]);

type EventMatcher = z.infer<typeof EventMatcherSchema>;

/** A filter for matching against data */
export type EventFilter = { [key: string]: EventMatcher | EventFilter };

export const EventFilterSchema: z.ZodType<EventFilter> = z.lazy(() =>
  z.record(z.union([EventMatcherSchema, EventFilterSchema]))
);

export const EventRuleSchema = z.object({
 event: z.union([z.string(), z.array(z.string())]),
  source: z.string(),
  payload: EventFilterSchema.optional(),
  context: EventFilterSchema.optional(),
});

export type EventRule = z.infer<typeof EventRuleSchema>;
