import { Ratelimit } from "@upstash/ratelimit";
import { type RedisWithClusterOptions } from "~/redis.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiter.server";
import { singleton } from "~/utils/singleton";

// The query ai-title endpoint lives under `/resources/*`, which the global
// apiRateLimiter (only `/api/*`) does not cover, so it needs its own per-user
// cap. Exported so the policy is asserted in tests rather than re-encoded.
export const AI_TITLE_RATE_LIMIT_ATTEMPTS = 30;
export const AI_TITLE_RATE_LIMIT_WINDOW = "10 m" as const;

/**
 * Build the ai-title per-user rate limiter. Production uses the env-derived
 * rate-limit Redis; tests inject a container Redis.
 */
export function createAITitleRateLimiter(redisOptions?: RedisWithClusterOptions): RateLimiter {
  return new RateLimiter({
    ...(redisOptions ? { redisClient: createRedisRateLimitClient(redisOptions) } : {}),
    keyPrefix: "query.ai-title",
    limiter: Ratelimit.slidingWindow(AI_TITLE_RATE_LIMIT_ATTEMPTS, AI_TITLE_RATE_LIMIT_WINDOW),
    logFailure: true,
  });
}

export const aiTitleRateLimiter = singleton("aiTitleRateLimiter", () => createAITitleRateLimiter());
