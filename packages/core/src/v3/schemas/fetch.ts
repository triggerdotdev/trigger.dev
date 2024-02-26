import { z } from "zod";
import { RetryOptions } from "./messages";
import { EventFilter } from "./eventFilter";

export const FetchRetryHeadersStrategy = z.object({
  /** The `headers` strategy retries the request using info from the response headers. */
  strategy: z.literal("headers"),
  /** The header to use to determine the maximum number of times to retry the request. */
  limitHeader: z.string(),
  /** The header to use to determine the number of remaining retries. */
  remainingHeader: z.string(),
  /** The header to use to determine the time when the number of remaining retries will be reset. */
  resetHeader: z.string(),
  /** The event filter to use to determine if the request should be retried. */
  bodyFilter: EventFilter.optional(),

  /** The format of the `resetHeader` value. */
  resetFormat: z
    .enum([
      "unix_timestamp",
      "unix_timestamp_in_ms",
      "iso_8601",
      "iso_8601_duration_openai_variant",
    ])
    .default("unix_timestamp")
    .optional(),
});

export type FetchRetryHeadersStrategy = z.infer<typeof FetchRetryHeadersStrategy>;

export const FetchRetryBackoffStrategy = RetryOptions.extend({
  /** The `backoff` strategy retries the request with an exponential backoff. */
  strategy: z.literal("backoff"),
  /** The event filter to use to determine if the request should be retried. */
  bodyFilter: EventFilter.optional(),
});

/** The `backoff` strategy retries the request with an exponential backoff. */
export type FetchRetryBackoffStrategy = z.infer<typeof FetchRetryBackoffStrategy>;

export const FetchRetryStrategy = z.discriminatedUnion("strategy", [
  FetchRetryHeadersStrategy,
  FetchRetryBackoffStrategy,
]);

export type FetchRetryStrategy = z.infer<typeof FetchRetryStrategy>;

export const FetchRetryOptions = z.record(FetchRetryStrategy);

/** An object where the key is a status code pattern and the value is a retrying strategy. Supported patterns are:
  - Specific status codes: 429
  - Ranges: 500-599
  - Wildcards: 2xx, 3xx, 4xx, 5xx 
  */
export type FetchRetryOptions = z.infer<typeof FetchRetryOptions>;

export const FetchTimeoutOptions = z.object({
  /** The maximum time to wait for the request to complete. */
  durationInMs: z.number().optional(),
  retry: RetryOptions.optional(),
});

export type FetchTimeoutOptions = z.infer<typeof FetchTimeoutOptions>;
