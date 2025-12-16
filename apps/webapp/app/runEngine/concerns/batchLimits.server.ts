import { Organization } from "@trigger.dev/database";
import { Ratelimit } from "@upstash/ratelimit";
import { z } from "zod";
import { env } from "~/env.server";
import { RateLimiterConfig } from "~/services/authorizationRateLimitMiddleware.server";
import { createRedisRateLimitClient, Duration, RateLimiter } from "~/services/rateLimiter.server";
import { singleton } from "~/utils/singleton";

const BatchLimitsConfig = z.object({
  processingConcurrency: z.number().int().default(env.BATCH_CONCURRENCY_LIMIT_DEFAULT),
});

/**
 * Batch limits configuration for a plan type
 */
export type BatchLimitsConfig = z.infer<typeof BatchLimitsConfig>;

const batchLimitsRedisClient = singleton("batchLimitsRedisClient", createBatchLimitsRedisClient);

function createBatchLimitsRedisClient() {
  const redisClient = createRedisRateLimitClient({
    port: env.RATE_LIMIT_REDIS_PORT,
    host: env.RATE_LIMIT_REDIS_HOST,
    username: env.RATE_LIMIT_REDIS_USERNAME,
    password: env.RATE_LIMIT_REDIS_PASSWORD,
    tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
    clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
  });

  return redisClient;
}

function createOrganizationRateLimiter(organization: Organization): RateLimiter {
  const limiterConfig = resolveBatchRateLimitConfig(organization.batchRateLimitConfig);

  const limiter =
    limiterConfig.type === "fixedWindow"
      ? Ratelimit.fixedWindow(limiterConfig.tokens, limiterConfig.window)
      : limiterConfig.type === "tokenBucket"
      ? Ratelimit.tokenBucket(
          limiterConfig.refillRate,
          limiterConfig.interval,
          limiterConfig.maxTokens
        )
      : Ratelimit.slidingWindow(limiterConfig.tokens, limiterConfig.window);

  return new RateLimiter({
    redisClient: batchLimitsRedisClient,
    keyPrefix: "ratelimit:batch",
    limiter,
    logSuccess: false,
    logFailure: true,
  });
}

function resolveBatchRateLimitConfig(batchRateLimitConfig?: unknown): RateLimiterConfig {
  const defaultRateLimiterConfig: RateLimiterConfig = {
    type: "tokenBucket",
    refillRate: env.BATCH_RATE_LIMIT_REFILL_RATE,
    interval: env.BATCH_RATE_LIMIT_REFILL_INTERVAL as Duration,
    maxTokens: env.BATCH_RATE_LIMIT_MAX,
  };

  if (!batchRateLimitConfig) {
    return defaultRateLimiterConfig;
  }

  const parsedBatchRateLimitConfig = RateLimiterConfig.safeParse(batchRateLimitConfig);

  if (!parsedBatchRateLimitConfig.success) {
    return defaultRateLimiterConfig;
  }

  return parsedBatchRateLimitConfig.data;
}

/**
 * Get the rate limiter and limits for an organization.
 * Internally looks up the plan type, but doesn't expose it to callers.
 */
export async function getBatchLimits(
  organization: Organization
): Promise<{ rateLimiter: RateLimiter; config: BatchLimitsConfig }> {
  const rateLimiter = createOrganizationRateLimiter(organization);
  const config = resolveBatchLimitsConfig(organization.batchQueueConcurrencyConfig);
  return { rateLimiter, config };
}

function resolveBatchLimitsConfig(batchLimitsConfig?: unknown): BatchLimitsConfig {
  const defaultLimitsConfig: BatchLimitsConfig = {
    processingConcurrency: env.BATCH_CONCURRENCY_LIMIT_DEFAULT,
  };

  if (!batchLimitsConfig) {
    return defaultLimitsConfig;
  }

  const parsedBatchLimitsConfig = BatchLimitsConfig.safeParse(batchLimitsConfig);

  if (!parsedBatchLimitsConfig.success) {
    return defaultLimitsConfig;
  }

  return parsedBatchLimitsConfig.data;
}

/**
 * Error thrown when batch rate limit is exceeded.
 * Contains information for constructing a proper 429 response.
 */
export class BatchRateLimitExceededError extends Error {
  constructor(
    public readonly limit: number,
    public readonly remaining: number,
    public readonly resetAt: Date,
    public readonly itemCount: number
  ) {
    super(
      `Batch rate limit exceeded. Attempted to submit ${itemCount} items but only ${remaining} remaining. Limit resets at ${resetAt.toISOString()}`
    );
    this.name = "BatchRateLimitExceededError";
  }
}
