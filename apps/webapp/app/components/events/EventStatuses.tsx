import { z } from "zod";
import { DirectionSchema, FilterableEnvironment } from "~/components/runs/RunStatuses";

export const EventListSearchSchema = z.object({
  cursor: z.string().optional(),
  direction: DirectionSchema.optional(),
  environment: FilterableEnvironment.optional(),
  from: z
    .string()
    .transform((value) => parseInt(value))
    .optional(),
  to: z
    .string()
    .transform((value) => parseInt(value))
    .optional(),
});
