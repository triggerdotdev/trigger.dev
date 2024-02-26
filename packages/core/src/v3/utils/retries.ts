import { type RetryOptions } from "../schemas";
import { calculateResetAt as calculateResetAtInternal } from "../../retry";

export const defaultRetryOptions = {
  maxAttempts: 10,
  factor: 2,
  minTimeoutInMs: 1000,
  maxTimeoutInMs: 60000,
  randomize: true,
} satisfies RetryOptions;

/**
 *
 * @param opts
 * @param attempt - The current attempt number. If the first attempt has failed, this will be 1.
 * @returns
 */
export function calculateNextRetryDelay(opts: Required<RetryOptions>, attempt: number) {
  if (attempt >= opts.maxAttempts) {
    return;
  }

  const { factor, minTimeoutInMs, maxTimeoutInMs, randomize } = opts;

  const random = randomize ? Math.random() + 1 : 1;

  const timeout = Math.min(maxTimeoutInMs, random * minTimeoutInMs * Math.pow(factor, attempt - 1));

  // Round to the nearest integer
  return Math.round(timeout);
}

export function calculateResetAt(
  resets: string | undefined | null,
  format:
    | "unix_timestamp"
    | "iso_8601"
    | "iso_8601_duration_openai_variant"
    | "unix_timestamp_in_ms",
  now: number = Date.now()
): number | undefined {
  const resetAt = calculateResetAtInternal(resets, format, new Date(now));

  return resetAt?.getTime();
}
