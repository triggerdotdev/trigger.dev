import { z } from "zod";
import { RedactStringSchema, RetryOptionsSchema } from "./api";

export const FetchRetryHeadersStrategySchema = z.object({
  strategy: z.literal("headers"),
  limitHeader: z.string(),
  remainingHeader: z.string(),
  resetHeader: z.string(),
});

export type FetchRetryHeadersStrategy = z.infer<
  typeof FetchRetryHeadersStrategySchema
>;

export const FetchRetryBackoffStrategySchema = RetryOptionsSchema.extend({
  strategy: z.literal("backoff"),
});

export type FetchRetryBackoffStrategy = z.infer<
  typeof FetchRetryBackoffStrategySchema
>;

export const FetchRetryStrategySchema = z.discriminatedUnion("strategy", [
  FetchRetryHeadersStrategySchema,
  FetchRetryBackoffStrategySchema,
]);

export type FetchRetryStrategy = z.infer<typeof FetchRetryStrategySchema>;

export const FetchRequestInitSchema = z.object({
  method: z.string().optional(),
  headers: z.record(z.union([z.string(), RedactStringSchema])).optional(),
  body: z.union([z.string(), z.instanceof(ArrayBuffer)]).optional(),
});

export type FetchRequestInit = z.infer<typeof FetchRequestInitSchema>;

export const FetchRetryOptionsSchema = z.record(FetchRetryStrategySchema);

export type FetchRetryOptions = z.infer<typeof FetchRetryOptionsSchema>;

export const FetchOperationSchema = z.object({
  url: z.string(),
  requestInit: FetchRequestInitSchema.optional(),
  retry: z.record(FetchRetryStrategySchema).optional(),
});

export type FetchOperation = z.infer<typeof FetchOperationSchema>;
