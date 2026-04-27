import { calculateNextRetryDelay } from "@trigger.dev/core/v3";
import type { RetryOptions } from "@trigger.dev/core/v3/schemas";

/**
 * RetryStrategy interface for pluggable retry logic.
 */
export interface RetryStrategy {
  /**
   * Calculate the next retry delay in milliseconds.
   * Return null to indicate the message should be sent to DLQ.
   *
   * @param attempt - Current attempt number (1-indexed)
   * @param error - Optional error from the failed attempt
   * @returns Delay in milliseconds, or null to send to DLQ
   */
  getNextDelay(attempt: number, error?: Error): number | null;

  /**
   * Maximum number of attempts before moving to DLQ.
   */
  maxAttempts: number;
}

/**
 * Exponential backoff retry strategy.
 *
 * Uses the same algorithm as @trigger.dev/core's calculateNextRetryDelay.
 */
export class ExponentialBackoffRetry implements RetryStrategy {
  readonly maxAttempts: number;
  private options: RetryOptions;

  constructor(options?: Partial<RetryOptions>) {
    this.options = {
      maxAttempts: options?.maxAttempts ?? 12,
      factor: options?.factor ?? 2,
      minTimeoutInMs: options?.minTimeoutInMs ?? 1_000,
      maxTimeoutInMs: options?.maxTimeoutInMs ?? 3_600_000, // 1 hour
      randomize: options?.randomize ?? true,
    };
    this.maxAttempts = this.options.maxAttempts ?? 12;
  }

  getNextDelay(attempt: number, _error?: Error): number | null {
    if (attempt >= this.maxAttempts) {
      return null; // Send to DLQ
    }

    const delay = calculateNextRetryDelay(this.options, attempt);
    return delay ?? null;
  }
}

/**
 * Fixed delay retry strategy.
 *
 * Always waits the same amount of time between retries.
 */
export class FixedDelayRetry implements RetryStrategy {
  readonly maxAttempts: number;
  private delayMs: number;

  constructor(options: { maxAttempts: number; delayMs: number }) {
    this.maxAttempts = options.maxAttempts;
    this.delayMs = options.delayMs;
  }

  getNextDelay(attempt: number, _error?: Error): number | null {
    if (attempt >= this.maxAttempts) {
      return null; // Send to DLQ
    }
    return this.delayMs;
  }
}

/**
 * Linear backoff retry strategy.
 *
 * Delay increases linearly with each attempt.
 */
export class LinearBackoffRetry implements RetryStrategy {
  readonly maxAttempts: number;
  private baseDelayMs: number;
  private maxDelayMs: number;

  constructor(options: { maxAttempts: number; baseDelayMs: number; maxDelayMs?: number }) {
    this.maxAttempts = options.maxAttempts;
    this.baseDelayMs = options.baseDelayMs;
    this.maxDelayMs = options.maxDelayMs ?? options.baseDelayMs * options.maxAttempts;
  }

  getNextDelay(attempt: number, _error?: Error): number | null {
    if (attempt >= this.maxAttempts) {
      return null; // Send to DLQ
    }
    const delay = this.baseDelayMs * attempt;
    return Math.min(delay, this.maxDelayMs);
  }
}

/**
 * No retry strategy.
 *
 * Messages go directly to DLQ on first failure.
 */
export class NoRetry implements RetryStrategy {
  readonly maxAttempts = 1;

  getNextDelay(_attempt: number, _error?: Error): number | null {
    return null; // Always send to DLQ
  }
}

/**
 * Immediate retry strategy.
 *
 * Retries immediately without any delay.
 */
export class ImmediateRetry implements RetryStrategy {
  readonly maxAttempts: number;

  constructor(maxAttempts: number) {
    this.maxAttempts = maxAttempts;
  }

  getNextDelay(attempt: number, _error?: Error): number | null {
    if (attempt >= this.maxAttempts) {
      return null; // Send to DLQ
    }
    return 0; // Immediate retry
  }
}

/**
 * Custom retry strategy that uses a user-provided function.
 */
export class CustomRetry implements RetryStrategy {
  readonly maxAttempts: number;
  private calculateDelay: (attempt: number, error?: Error) => number | null;

  constructor(options: {
    maxAttempts: number;
    calculateDelay: (attempt: number, error?: Error) => number | null;
  }) {
    this.maxAttempts = options.maxAttempts;
    this.calculateDelay = options.calculateDelay;
  }

  getNextDelay(attempt: number, error?: Error): number | null {
    if (attempt >= this.maxAttempts) {
      return null;
    }
    return this.calculateDelay(attempt, error);
  }
}

/**
 * Default retry options matching @trigger.dev/core defaults.
 */
export const defaultRetryOptions: RetryOptions = {
  maxAttempts: 12,
  factor: 2,
  minTimeoutInMs: 1_000,
  maxTimeoutInMs: 3_600_000,
  randomize: true,
};

/**
 * Create an exponential backoff retry strategy with default options.
 */
export function createDefaultRetryStrategy(): RetryStrategy {
  return new ExponentialBackoffRetry(defaultRetryOptions);
}
