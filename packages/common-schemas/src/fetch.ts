import { z } from "zod";

export const SecureStringSchema = z.object({
  __secureString: z.literal(true),
  strings: z.array(z.string()),
  interpolations: z.array(z.string()),
});

export type SecureString = z.infer<typeof SecureStringSchema>;

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
