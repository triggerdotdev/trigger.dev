import { z } from "zod";

export const ErrorWithStackSchema = z.object({
  message: z.string(),
  name: z.string().optional(),
  stack: z.string().optional(),
});

export type ErrorWithStack = z.infer<typeof ErrorWithStackSchema>;
