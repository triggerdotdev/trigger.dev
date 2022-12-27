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
