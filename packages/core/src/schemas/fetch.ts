import { z } from "zod";
import { RedactStringSchema, RetryOptionsSchema } from "./api.js";
import { EventFilterSchema } from "./eventFilter.js";
import { ResponseFilterSchema } from "./requestFilter.js";
import { Prettify } from "../types.js";

export const FetchRetryHeadersStrategySchema = z.object({
  /** The `headers` strategy retries the request using info from the response headers. */
  strategy: z.literal("headers"),
  /** The header to use to determine the maximum number of times to retry the request. */
  limitHeader: z.string(),
  /** The header to use to determine the number of remaining retries. */
  remainingHeader: z.string(),
  /** The header to use to determine the time when the number of remaining retries will be reset. */
  resetHeader: z.string(),
  /** The event filter to use to determine if the request should be retried. */
  bodyFilter: EventFilterSchema.optional(),

  /** The format of the `resetHeader` value. */
  resetFormat: z
    .enum([
      "unix_timestamp",
      "unix_timestamp_in_ms",
      "iso_8601",
      "iso_8601_duration_openai_variant",
    ])
    .default("unix_timestamp"),
});

export type FetchRetryHeadersStrategy = z.infer<typeof FetchRetryHeadersStrategySchema>;

/** The `backoff` strategy retries the request with an exponential backoff. */
export const FetchRetryBackoffStrategySchema = RetryOptionsSchema.extend({
  /** The `backoff` strategy retries the request with an exponential backoff. */
  strategy: z.literal("backoff"),
  /** The event filter to use to determine if the request should be retried. */
  bodyFilter: EventFilterSchema.optional(),
});

/** The `backoff` strategy retries the request with an exponential backoff. */
export type FetchRetryBackoffStrategy = z.infer<typeof FetchRetryBackoffStrategySchema>;

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

export const FetchTimeoutOptionsSchema = z.object({
  durationInMs: z.number(),
  retry: RetryOptionsSchema.optional(),
});

export type FetchTimeoutOptions = z.infer<typeof FetchTimeoutOptionsSchema>;

export const FetchOperationSchema = z.object({
  url: z.string(),
  requestInit: FetchRequestInitSchema.optional(),
  retry: z.record(FetchRetryStrategySchema).optional(),
  timeout: FetchTimeoutOptionsSchema.optional(),
});

export type FetchOperation = z.infer<typeof FetchOperationSchema>;

export const FetchPollOperationSchema = z.object({
  url: z.string(),
  interval: z.number().int().positive().min(10).max(600).default(10), // defaults to 10 seconds
  timeout: z.number().int().positive().min(30).max(3600).default(600), // defaults to 10 minutes
  responseFilter: ResponseFilterSchema,
  requestInit: FetchRequestInitSchema.optional(),
  requestTimeout: FetchTimeoutOptionsSchema.optional(),
});

export type FetchPollOperation = Prettify<z.infer<typeof FetchPollOperationSchema>>;
