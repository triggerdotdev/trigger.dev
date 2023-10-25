import { z } from "zod";
import { EventFilterSchema, stringPatternMatchers } from "./eventFilter";

const StringMatchSchema = z.union([
  /** Match against a string */
  z.array(z.string()),
  z.array(z.union(stringPatternMatchers)),
]);

export type StringMatch = z.infer<typeof StringMatchSchema>;

export const HTTPMethodUnionSchema = z.union([
  z.literal("GET"),
  z.literal("POST"),
  z.literal("PUT"),
  z.literal("PATCH"),
  z.literal("DELETE"),
  z.literal("HEAD"),
  z.literal("OPTIONS"),
]);

export type HttpMethod = z.infer<typeof HTTPMethodUnionSchema>;

export const RequestFilterSchema = z.object({
  method: z.array(HTTPMethodUnionSchema).optional(),
  headers: z.record(StringMatchSchema).optional(),
  query: z.record(StringMatchSchema).optional(),
  body: EventFilterSchema.optional(),
});

export type RequestFilter = z.infer<typeof RequestFilterSchema>;
