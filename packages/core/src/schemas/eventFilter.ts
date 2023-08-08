import { z } from "zod";

const EventMatcherSchema = z.union([
  /** Match against a string */
  z.array(z.string()),
  /** Match against a number */
  z.array(z.number()),
  /** Match against a boolean */
  z.array(z.boolean()),
  z.array(
    z.union([
      z.object({
        $endsWith: z.string(),
      }),
      z.object({
        $startsWith: z.string(),
      }),
      z.object({
        $exists: z.boolean(),
      }),
      z.object({
        $anythingBut: z.union([z.string(), z.number(), z.boolean()]),
      }),
      z.object({
        $anythingBut: z.union([z.array(z.string()), z.array(z.number()), z.array(z.boolean())]),
      }),
      z.object({
        $gt: z.number(),
      }),
      z.object({
        $lt: z.number(),
      }),
      z.object({
        $gte: z.number(),
      }),
      z.object({
        $lte: z.number(),
      }),
      z.object({
        $between: z.tuple([z.number(), z.number()]),
      }),
      z.object({
        $includes: z.union([z.string(), z.number(), z.boolean()]),
      }),
      z.object({
        $ignoreCaseEquals: z.string(),
      }),
    ])
  ),
]);

type EventMatcher = z.infer<typeof EventMatcherSchema>;

/** A filter for matching against data */
export type EventFilter = { [key: string]: EventMatcher | EventFilter };

export const EventFilterSchema: z.ZodType<EventFilter> = z.lazy(() =>
  z.record(z.union([EventMatcherSchema, EventFilterSchema]))
);

export const EventRuleSchema = z.object({
  event: z.string().or(z.array(z.string())),
  source: z.string(),
  payload: EventFilterSchema.optional(),
  context: EventFilterSchema.optional(),
});

export type EventRule = z.infer<typeof EventRuleSchema>;
