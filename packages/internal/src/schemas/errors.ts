import { z } from "zod";

export const ErrorWithMessage = z.object({
  message: z.string(),
});

export const ErrorWithStackSchema = ErrorWithMessage.extend({
  stack: z.string().optional(),
});
