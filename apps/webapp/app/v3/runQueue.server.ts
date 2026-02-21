import { type AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { marqs } from "./marqs/index.server";
import { engine } from "./runEngine.server";

// Re-export pure utility function from durations.ts (testable without env deps)
export { parseDurationToMs } from "./utils/durations";

//This allows us to update MARQS and the RunQueue

/** Rate limit configuration for a queue */
export type QueueRateLimitConfig = {
  /** Maximum number of requests allowed in the period */
  limit: number;
  /** Time window in milliseconds */
  periodMs: number;
  /** Optional burst allowance (defaults to limit) */
  burst?: number;
};

/** Updates MARQS and the RunQueue limits */
export async function updateEnvConcurrencyLimits(
  environment: AuthenticatedEnvironment,
  maximumConcurrencyLimit?: number
) {
  let updatedEnvironment = environment;
  if (maximumConcurrencyLimit !== undefined) {
    updatedEnvironment.maximumConcurrencyLimit = maximumConcurrencyLimit;
  }

  await Promise.allSettled([
    marqs?.updateEnvConcurrencyLimits(updatedEnvironment),
    engine.runQueue.updateEnvConcurrencyLimits(updatedEnvironment),
  ]);
}

/** Updates MARQS and the RunQueue limits for a queue */
export async function updateQueueConcurrencyLimits(
  environment: AuthenticatedEnvironment,
  queueName: string,
  concurrency: number
) {
  await Promise.allSettled([
    marqs?.updateQueueConcurrencyLimits(environment, queueName, concurrency),
    engine.runQueue.updateQueueConcurrencyLimits(environment, queueName, concurrency),
  ]);
}

/** Removes MARQS and the RunQueue limits for a queue */
export async function removeQueueConcurrencyLimits(
  environment: AuthenticatedEnvironment,
  queueName: string
) {
  await Promise.allSettled([
    marqs?.removeQueueConcurrencyLimits(environment, queueName),
    engine.runQueue.removeQueueConcurrencyLimits(environment, queueName),
  ]);
}

/** Updates the rate limit configuration for a queue in Redis */
export async function updateQueueRateLimitConfig(
  environment: AuthenticatedEnvironment,
  queueName: string,
  config: QueueRateLimitConfig
) {
  await engine.runQueue.setQueueRateLimitConfig(environment, queueName, config);
}

/** Removes the rate limit configuration for a queue from Redis */
export async function removeQueueRateLimitConfig(
  environment: AuthenticatedEnvironment,
  queueName: string
) {
  await engine.runQueue.removeQueueRateLimitConfig(environment, queueName);
}
