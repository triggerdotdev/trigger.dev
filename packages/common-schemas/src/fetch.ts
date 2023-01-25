import { z } from "zod";

export const SecureStringSchema = z.object({
  __secureString: z.literal(true),
  strings: z.array(z.string()),
  interpolations: z.array(z.string()),
});

export type SecureString = z.infer<typeof SecureStringSchema>;

export const RetrySchema = z.object({
  enabled: z.boolean().default(true),
  factor: z.number().default(1.8),
  maxTimeout: z.number().default(60000),
  minTimeout: z.number().default(1000),
  maxAttempts: z.number().default(10),
  statusCodes: z.array(z.number()).default([408, 429, 500, 502, 503, 504]),
});

export const FetchRequestSchema = z.object({
  url: z.string(),
  headers: z.record(z.union([z.string(), SecureStringSchema])).optional(),
  method: z.enum([
    "GET",
    "POST",
    "PUT",
    "DELETE",
    "PATCH",
    "HEAD",
    "OPTIONS",
    "TRACE",
  ]),
  body: z.any(),
  retry: RetrySchema.optional(),
});

export const FetchOutputSchema = z.object({
  status: z.number(),
  ok: z.boolean(),
  headers: z.record(z.string()),
  body: z.any().optional(),
});

export type FetchRequest = z.infer<typeof FetchRequestSchema>;
export type FetchOutput = z.infer<typeof FetchOutputSchema>;

export const FetchResponseSchema = z.object({
  status: z.number(),
  headers: z.record(z.string()),
  body: z.any().optional(),
});
