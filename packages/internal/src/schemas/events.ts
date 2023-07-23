import { z } from "zod";
import { RunStatusSchema } from "./runs";

export const GetEventSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  runs: z.array(
    z.object({
      id: z.string(),
      status: RunStatusSchema,
      startedAt: z.coerce.date().optional().nullable(),
      completedAt: z.coerce.date().optional().nullable(),
    })
  ),
});
