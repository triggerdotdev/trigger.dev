import { z } from "zod";

export const DisplayElementSchema = z.object({
  label: z.string(),
  text: z.string(),
  url: z.string().optional(),
});

export type DisplayElement = z.infer<typeof DisplayElementSchema>;
