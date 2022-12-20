import { z } from "zod";

export const ErrorSchema = z.object({
  name: z.string(),
  message: z.string(),
  stackTrace: z.string().optional(),
});
