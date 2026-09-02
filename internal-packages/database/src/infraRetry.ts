import { isRetryableInfrastructureError } from "./infraError";
import { type RetryBudget, UNLIMITED_RETRY_BUDGET } from "./transaction";

/** Retry tuning for {@link withInfraRetry}. */
export type InfraRetryOptions = {
  /** Kill switch. When false, the thunk runs exactly once. Default off at call sites. */
  enabled: boolean;
  /** Total attempts including the first. `1` (or less) disables retrying. */
  maxAttempts: number;
  /** Lower bound of the jittered backoff between attempts, in ms. */
  backoffMinMs: number;
  /** Upper bound of the jittered backoff between attempts, in ms. */
  backoffMaxMs: number;
};

export type InfraRetryConfig = {
  options: InfraRetryOptions;
  /** Shared budget; defaults to {@link UNLIMITED_RETRY_BUDGET}. */
  budget?: RetryBudget;
  /** Predicate for a retryable error; defaults to {@link isRetryableInfrastructureError}. */
  isRetryable?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `run` and retries it on a transient connection-blip error ({@link isRetryableInfrastructureError}
 * by default), up to `maxAttempts` with jittered backoff, gated by a shared
 * `budget` so a mass freeze can't amplify into a retry storm. Any other error
 * (or an exhausted budget) rethrows immediately.
 *
 * ONLY wrap operations that are safe to run more than once: reads, or writes
 * that have been made idempotent. Never wrap a bare non-idempotent write.
 */
export async function withInfraRetry<R>(
  run: () => Promise<R>,
  config?: InfraRetryConfig
): Promise<R> {
  if (!config || !config.options.enabled) {
    return run();
  }

  const { backoffMinMs, backoffMaxMs } = config.options;
  // Bound the loop defensively: a non-finite maxAttempts (NaN/Infinity from a bad
  // env parse) or a value below 2 means "run once, no retry" — never a skipped run
  // or an unbounded loop. Fractional values floor to whole attempts.
  const maxAttempts = Number.isFinite(config.options.maxAttempts)
    ? Math.floor(config.options.maxAttempts)
    : 1;
  if (maxAttempts <= 1) {
    return run();
  }

  const budget = config.budget ?? UNLIMITED_RETRY_BUDGET;
  const isRetryable = config.isRetryable ?? isRetryableInfrastructureError;
  const sleep = config.sleep ?? defaultSleep;
  const random = config.random ?? Math.random;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryable(error) || !budget.tryConsume()) {
        throw error;
      }
      // Defend the delay math: non-finite bounds fall back to 0, and an injected
      // random() outside [0, 1] is clamped, so delayMs is always finite and within
      // [low, high]. A swapped min/max still collapses to the smaller bound.
      const min = Number.isFinite(backoffMinMs) ? backoffMinMs : 0;
      const max = Number.isFinite(backoffMaxMs) ? backoffMaxMs : min;
      const low = Math.max(0, Math.min(min, max));
      const high = Math.max(low, max);
      const rand = random();
      const r = Number.isFinite(rand) ? Math.min(1, Math.max(0, rand)) : 0;
      const delayMs = Math.round(low + r * (high - low));
      config.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  // Unreachable: the final attempt always returns or throws above. Present so the
  // function is statically known to return `R` or throw on every path.
  throw lastError;
}
