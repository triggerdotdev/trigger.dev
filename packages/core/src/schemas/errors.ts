import { z } from "zod";

export const ErrorWithStackSchema = z.object({
  message: z.string(),
  name: z.string().optional(),
  stack: z.string().optional(),
});

export type ErrorWithStack = z.infer<typeof ErrorWithStackSchema>;

export const SchemaErrorSchema = z.object({
  path: z.array(z.string()),
  message: z.string(),
});

export type SchemaError = z.infer<typeof SchemaErrorSchema>;
