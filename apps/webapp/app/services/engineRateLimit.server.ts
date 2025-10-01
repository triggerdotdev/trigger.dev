import { env } from "~/env.server";
import { authorizationRateLimitMiddleware } from "./authorizationRateLimitMiddleware.server";
import { Duration } from "./rateLimiter.server";

export const engineRateLimiter = authorizationRateLimitMiddleware({
  redis: {
    port: env.RATE_LIMIT_REDIS_PORT,
    host: env.RATE_LIMIT_REDIS_HOST,
    username: env.RATE_LIMIT_REDIS_USERNAME,
    password: env.RATE_LIMIT_REDIS_PASSWORD,
    tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
    clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
  },
  keyPrefix: "engine",
  defaultLimiter: {
    type: "tokenBucket",
    refillRate: env.RUN_ENGINE_RATE_LIMIT_REFILL_RATE,
    interval: env.RUN_ENGINE_RATE_LIMIT_REFILL_INTERVAL as Duration,
    maxTokens: env.RUN_ENGINE_RATE_LIMIT_MAX,
  },
  limiterCache: {
    fresh: 60_000 * 10, // Data is fresh for 10 minutes
    stale: 60_000 * 20, // Date is stale after 20 minutes
    maxItems: 1000,
  },
  pathMatchers: [/^\/engine/],
  // Regex allow any path starting with /engine/v1/worker-actions/
  pathWhiteList: [/^\/engine\/v1\/worker-actions\/.*/],
  log: {
    rejections: env.RUN_ENGINE_RATE_LIMIT_REJECTION_LOGS_ENABLED === "1",
    requests: env.RUN_ENGINE_RATE_LIMIT_REQUEST_LOGS_ENABLED === "1",
    limiter: env.RUN_ENGINE_RATE_LIMIT_LIMITER_LOGS_ENABLED === "1",
  },
});
