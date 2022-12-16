import { z } from "zod";

export const CustomEventSchema = z.object({
  name: z.string(),
  payload: z.record(z.string()),
  timestamp: z.string().datetime().optional(),
  context: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()])
    )
    .default({}),
});

export type CustomEvent = z.infer<typeof CustomEventSchema>;
