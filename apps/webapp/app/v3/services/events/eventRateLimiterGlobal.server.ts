import { env } from "~/env.server";
import { createRedisRateLimitClient } from "~/services/rateLimiter.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import {
  InMemoryEventRateLimitChecker,
  RedisEventRateLimitChecker,
} from "./eventRateLimiter.server";
import type { EventRateLimitChecker } from "./eventRateLimiter.server";

/**
 * Global singleton for the event publish rate limiter.
 *
 * Uses Redis when RATE_LIMIT_REDIS_HOST is configured (production),
 * falls back to in-memory sliding window otherwise (dev/testing).
 */
export const eventPublishRateLimitChecker = singleton(
  "eventPublishRateLimitChecker",
  initializeRateLimitChecker
);

function initializeRateLimitChecker(): EventRateLimitChecker {
  if (env.RATE_LIMIT_REDIS_HOST) {
    logger.info("Event rate limiter: using Redis-backed implementation");

    const redisClient = createRedisRateLimitClient({
      port: env.RATE_LIMIT_REDIS_PORT,
      host: env.RATE_LIMIT_REDIS_HOST,
      username: env.RATE_LIMIT_REDIS_USERNAME,
      password: env.RATE_LIMIT_REDIS_PASSWORD,
      tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
      clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
    });

    return new RedisEventRateLimitChecker(redisClient);
  }

  logger.info("Event rate limiter: using in-memory implementation (no RATE_LIMIT_REDIS_HOST)");
  return new InMemoryEventRateLimitChecker();
}
