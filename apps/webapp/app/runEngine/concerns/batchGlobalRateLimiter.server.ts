import { Ratelimit } from "@upstash/ratelimit";
import type { GlobalRateLimiter } from "@trigger.dev/redis-worker";
import { RateLimiter } from "~/services/rateLimiter.server";

/**
 * Creates a global rate limiter for the batch queue that limits
 * the maximum number of items processed per second across all consumers.
 *
 * Uses a token bucket algorithm where:
 * - `itemsPerSecond` tokens are available per second
 * - The bucket can hold up to `itemsPerSecond` tokens (burst capacity)
 *
 * @param itemsPerSecond - Maximum items to process per second
 * @returns A GlobalRateLimiter compatible with FairQueue
 */
export function createBatchGlobalRateLimiter(itemsPerSecond: number): GlobalRateLimiter {
  const limiter = new RateLimiter({
    keyPrefix: "batch-queue-global",
    // Token bucket: refills `itemsPerSecond` tokens every second
    // Bucket capacity is also `itemsPerSecond` (allows burst up to limit)
    limiter: Ratelimit.tokenBucket(itemsPerSecond, "1 s", itemsPerSecond),
    logSuccess: false,
    logFailure: true,
  });

  return {
    async limit() {
      const result = await limiter.limit("global");
      return {
        allowed: result.success,
        resetAt: result.reset,
      };
    },
  };
}

