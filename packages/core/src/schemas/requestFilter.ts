import { z } from "zod";
import { EventFilterSchema, stringPatternMatchers } from "./eventFilter";

const StringMatchSchema = z.union([
  /** Match against a string */
  z.array(z.string()),
  z.array(z.union(stringPatternMatchers)),
]);

export const RequestFilterSchema = z.object({
  headers: z.record(StringMatchSchema),
  query: z.record(StringMatchSchema),
  body: EventFilterSchema.optional(),
});
