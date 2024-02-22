import { type RetryOptions } from "../schemas";

export const defaultRetryOptions = {
  maxAttempts: 10,
  factor: 2,
  minTimeoutInMs: 1000,
  maxTimeoutInMs: 60000,
  randomize: true,
};

export function calculateNextRetryTimestamp(opts: Required<RetryOptions>, attempt: number) {
  if (attempt >= opts.maxAttempts) {
    return;
  }

  const { factor, minTimeoutInMs, maxTimeoutInMs, randomize } = opts;

  const random = randomize ? Math.random() + 1 : 1;

  const timeout = Math.min(maxTimeoutInMs, random * minTimeoutInMs * Math.pow(factor, attempt));

  // return the date in the future
  return Date.now() + timeout;
}
