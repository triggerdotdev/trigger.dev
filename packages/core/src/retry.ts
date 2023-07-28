import { RetryOptions } from "./schemas";

const DEFAULT_RETRY_OPTIONS = {
  limit: 5,
  factor: 1.8,
  minTimeoutInMs: 1000,
  maxTimeoutInMs: 60000,
  randomize: true,
} satisfies RetryOptions;

export function calculateRetryAt(
  retryOptions: RetryOptions,
  attempts: number
): Date | undefined {
  const options = {
    ...DEFAULT_RETRY_OPTIONS,
    ...retryOptions,
  };

  const retryCount = attempts + 1;

  if (retryCount >= options.limit) {
    return;
  }

  const random = options.randomize ? Math.random() + 1 : 1;

  let timeoutInMs = Math.round(
    random *
      Math.max(options.minTimeoutInMs, 1) *
      Math.pow(options.factor, Math.max(attempts - 1, 0))
  );

  timeoutInMs = Math.min(timeoutInMs, options.maxTimeoutInMs);

  return new Date(Date.now() + timeoutInMs);
}
