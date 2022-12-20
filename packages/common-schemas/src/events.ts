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
