import { z } from "zod";
import { DirectionSchema, FilterableEnvironment } from "~/components/runs/RunStatuses";

export const EventListSearchSchema = z.object({
  cursor: z.string().optional(),
  direction: DirectionSchema.optional(),
  environment: FilterableEnvironment.optional(),
});
