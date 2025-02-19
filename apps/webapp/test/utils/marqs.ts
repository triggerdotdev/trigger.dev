import { MarQSKeyProducer } from "~/v3/marqs/types";
import { MarQSShortKeyProducer } from "~/v3/marqs/marqsKeyProducer.js";
import Redis from "ioredis";

export function createKeyProducer(prefix: string): MarQSKeyProducer {
  return new MarQSShortKeyProducer(prefix);
}

export type SetupQueueOptions = {
  parentQueue: string;
  redis: Redis;
  score: number;
  queueId: string;
  orgId: string;
  envId: string;
  keyProducer: MarQSKeyProducer;
};

export type ConcurrencySetupOptions = {
  keyProducer: MarQSKeyProducer;
  redis: Redis;
  orgId: string;
  envId: string;
  currentConcurrency?: number;
  orgLimit?: number;
  envLimit?: number;
  isOrgDisabled?: boolean;
};

/**
 * Adds a queue to Redis with the given parameters
 */
export async function setupQueue({
  redis,
  keyProducer,
  parentQueue,
  score,
  queueId,
  orgId,
  envId,
}: SetupQueueOptions) {
  // Add the queue to the parent queue's sorted set
  const queue = keyProducer.queueKey(orgId, envId, queueId);

  await redis.zadd(parentQueue, score, queue);
}

type SetupConcurrencyOptions = {
  redis: Redis;
  keyProducer: MarQSKeyProducer;
  env: { id: string; currentConcurrency: number; limit?: number; reserveConcurrency?: number };
};

/**
 * Sets up concurrency-related Redis keys for orgs and envs
 */
export async function setupConcurrency({ redis, keyProducer, env }: SetupConcurrencyOptions) {
  // Set env concurrency limit
  if (typeof env.limit === "number") {
    await redis.set(keyProducer.envConcurrencyLimitKey(env.id), env.limit.toString());
  }

  if (env.currentConcurrency > 0) {
    // Set current concurrency by adding dummy members to the set
    const envCurrentKey = keyProducer.envCurrentConcurrencyKey(env.id);

    // Add dummy running job IDs to simulate current concurrency
    const dummyJobs = Array.from(
      { length: env.currentConcurrency },
      (_, i) => `dummy-job-${i}-${Date.now()}`
    );

    await redis.sadd(envCurrentKey, ...dummyJobs);
  }

  if (env.reserveConcurrency && env.reserveConcurrency > 0) {
    // Set reserved concurrency by adding dummy members to the set
    const envReservedKey = keyProducer.envReserveConcurrencyKey(env.id);

    // Add dummy reserved job IDs to simulate reserved concurrency
    const dummyJobs = Array.from(
      { length: env.reserveConcurrency },
      (_, i) => `dummy-reserved-job-${i}-${Date.now()}`
    );

    await redis.sadd(envReservedKey, ...dummyJobs);
  }
}

/**
 * Calculates the standard deviation of a set of numbers.
 * Standard deviation measures the amount of variation of a set of values from their mean.
 * A low standard deviation indicates that the values tend to be close to the mean.
 *
 * @param values Array of numbers to calculate standard deviation for
 * @returns The standard deviation of the values
 */
export function calculateStandardDeviation(values: number[]): number {
  // If there are no values or only one value, the standard deviation is 0
  if (values.length <= 1) {
    return 0;
  }

  // Calculate the mean (average) of the values
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;

  // Calculate the sum of squared differences from the mean
  const squaredDifferences = values.map((value) => Math.pow(value - mean, 2));
  const sumOfSquaredDifferences = squaredDifferences.reduce((sum, value) => sum + value, 0);

  // Calculate the variance (average of squared differences)
  const variance = sumOfSquaredDifferences / (values.length - 1); // Using n-1 for sample standard deviation

  // Standard deviation is the square root of the variance
  return Math.sqrt(variance);
}
