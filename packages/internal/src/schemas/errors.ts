import { z } from "zod";

export const ErrorWithStackSchema = z.object({
  message: z.string(),
  stack: z.string().optional(),
});

export type ErrorWithStack = z.infer<typeof ErrorWithStackSchema>;
