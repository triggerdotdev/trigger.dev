import { calculateNextRetryDelay } from "../../utils/retries.js";
import type { ApiResult } from "../../zodfetch.js";

/**
 * A wall-clock budget for retrying `continue`, the call that resumes a run restored from a
 * checkpoint. A run whose `continue` fails is aborted, so temporary failures are retried for the
 * whole budget rather than for a fixed number of attempts.
 */
export type ContinueRetryBudget = {
  budgetMs: number;
  /** Backoff for temporary failures: jittered, doubling from `minDelayMs` up to `maxDelayMs`. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Backoff cap for a plain server error, which only gets the usual number of attempts. */
  serverErrorMaxDelayMs?: number;
  /**
   * Don't start another attempt with less than this left. It would be cut off here, but the
   * request it sent would keep running on the server.
   */
  minAttemptBudgetMs?: number;
};

/** What the retry loop did, for logs and metrics. */
export type ContinueRetrySummary = {
  attempts: number;
  elapsedMs: number;
  outcome: "succeeded" | "non_retryable" | "server_errors" | "budget_exhausted";
};

// "Try again later": a busy run lock (409), a temporary database error (503), the load balancer
// cutting off a slow request (502/504), a request timeout (408) or a rate limit (429).
const TEMPORARY_STATUSES = new Set([408, 409, 429, 502, 503, 504]);

// A plain server error is unexpected, and retrying rarely fixes it. It keeps the usual number of
// attempts, so an HTTP 5xx from a bug fails as fast as before. A failure with no status at all (a
// dropped connection, or an attempt cut off at the budget) is retried for the whole budget, by
// design: that is what a network blip looks like.
const SERVER_ERROR_ATTEMPTS = 8;

export async function retryContinueWithinBudget<T>(
  attempt: (signal: AbortSignal) => Promise<ApiResult<T>>,
  {
    budgetMs,
    minDelayMs = 500,
    maxDelayMs = 30_000,
    serverErrorMaxDelayMs = 10_000,
    minAttemptBudgetMs = 5_000,
  }: ContinueRetryBudget
): Promise<ApiResult<T> & { retry: ContinueRetrySummary }> {
  const start = Date.now();
  const deadline = start + budgetMs;
  let serverErrors = 0;

  for (let attemptNumber = 1; ; attemptNumber++) {
    // No attempt runs past the budget, so the caller always gets an answer in time.
    const result = await attempt(AbortSignal.timeout(Math.max(1, deadline - Date.now())));

    const stop = (outcome: ContinueRetrySummary["outcome"]) => ({
      ...result,
      retry: { attempts: attemptNumber, elapsedMs: Date.now() - start, outcome },
    });

    if (result.success) {
      return stop("succeeded");
    }

    // The server's x-should-retry header overrides the status, as it does for every other call.
    if (result.shouldRetry === false) {
      return stop("non_retryable");
    }

    // No status means there was no response: a dropped connection, or the attempt timed out.
    const status = result.statusCode;
    const temporary =
      result.shouldRetry === true || status === undefined || TEMPORARY_STATUSES.has(status);
    const serverError = status !== undefined && !temporary && status >= 500;

    if (!temporary && !serverError) {
      return stop("non_retryable");
    }

    if (serverError && ++serverErrors >= SERVER_ERROR_ATTEMPTS) {
      return stop("server_errors");
    }

    const delay = calculateNextRetryDelay(
      {
        minTimeoutInMs: minDelayMs,
        maxTimeoutInMs: temporary ? maxDelayMs : serverErrorMaxDelayMs,
        factor: 2,
        randomize: true,
        maxAttempts: Number.POSITIVE_INFINITY,
      },
      attemptNumber
    );

    if (delay === undefined || Date.now() + delay + minAttemptBudgetMs > deadline) {
      return stop("budget_exhausted");
    }

    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
