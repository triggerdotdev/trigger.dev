import { z } from "zod";
import { RedactStringSchema, RetryOptionsSchema } from "./api";

export const FetchRetryHeadersStrategySchema = z.object({
  /** The `headers` strategy retries the request using info from the response headers. */
  strategy: z.literal("headers"),
  /** The header to use to determine the maximum number of times to retry the request. */
  limitHeader: z.string(),
  /** The header to use to determine the number of remaining retries. */
  remainingHeader: z.string(),
  /** The header to use to determine the time when the number of remaining retries will be reset. */
  resetHeader: z.string(),
});

export type FetchRetryHeadersStrategy = z.infer<
  typeof FetchRetryHeadersStrategySchema
>;

/** The `backoff` strategy retries the request with an exponential backoff. */
export const FetchRetryBackoffStrategySchema = RetryOptionsSchema.extend({
  /** The `backoff` strategy retries the request with an exponential backoff. */
  strategy: z.literal("backoff"),
});

/** The `backoff` strategy retries the request with an exponential backoff. */
export type FetchRetryBackoffStrategy = z.infer<
  typeof FetchRetryBackoffStrategySchema
>;

export const FetchRetryStrategySchema = z.discriminatedUnion("strategy", [
  FetchRetryHeadersStrategySchema,
  FetchRetryBackoffStrategySchema,
]);

export type FetchRetryStrategy = z.infer<typeof FetchRetryStrategySchema>;

/** The options for a fetch request */
export const FetchRequestInitSchema = z.object({
  /** The HTTP method to use for the request. */
  method: z.string().optional(),
  /** Any headers to send with the request. Note that you can use [redactString](https://trigger.dev/docs/sdk/redactString) to prevent sensitive information from being stored (e.g. in the logs), like API keys and tokens. */
  headers: z.record(z.union([z.string(), RedactStringSchema])).optional(),
  /** The body of the request. */
  body: z.union([z.string(), z.instanceof(ArrayBuffer)]).optional(),
});

/** The options for a fetch request */
export type FetchRequestInit = z.infer<typeof FetchRequestInitSchema>;

export const FetchRetryOptionsSchema = z.record(FetchRetryStrategySchema);

/** An object where the key is a status code pattern and the value is a retrying strategy. Supported patterns are:
  - Specific status codes: 429
  - Ranges: 500-599
  - Wildcards: 2xx, 3xx, 4xx, 5xx 
  */
export type FetchRetryOptions = z.infer<typeof FetchRetryOptionsSchema>;

export const FetchOperationSchema = z.object({
  url: z.string(),
  requestInit: FetchRequestInitSchema.optional(),
  retry: z.record(FetchRetryStrategySchema).optional(),
});

export type FetchOperation = z.infer<typeof FetchOperationSchema>;
