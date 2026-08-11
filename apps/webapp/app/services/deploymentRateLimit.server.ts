import { env } from "~/env.server";
import { resolvePrivateApiKeyRateLimitScope } from "~/models/runtimeEnvironment.server";
import { authorizationRateLimitMiddleware } from "./authorizationRateLimitMiddleware.server";
import { deploymentApiPaths } from "./deploymentApiPaths.server";
import type { Duration } from "./rateLimiter.server";

export const deploymentRateLimiter = authorizationRateLimitMiddleware({
  redis: {
    port: env.RATE_LIMIT_REDIS_PORT,
    host: env.RATE_LIMIT_REDIS_HOST,
    username: env.RATE_LIMIT_REDIS_USERNAME,
    password: env.RATE_LIMIT_REDIS_PASSWORD,
    tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
    clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
  },
  keyPrefix: "deployment",
  defaultLimiter: {
    type: "tokenBucket",
    refillRate: env.DEPLOYMENT_RATE_LIMIT_REFILL_RATE,
    interval: env.DEPLOYMENT_RATE_LIMIT_REFILL_INTERVAL as Duration,
    maxTokens: env.DEPLOYMENT_RATE_LIMIT_MAX,
  },
  limiterCache: {
    fresh: 60_000 * 10,
    stale: 60_000 * 20,
    maxItems: 1000,
  },
  limiterConfigOverride: async (authorizationValue) => {
    const rawApiKey = authorizationValue.replace(/^Bearer /, "");

    if (!rawApiKey.startsWith("tr_")) {
      return;
    }

    const scope = await resolvePrivateApiKeyRateLimitScope(rawApiKey);

    if (!scope) {
      return;
    }

    // Identifier only: the org's apiRateLimiterConfig governs the general API
    // limiter, not the deploy budget.
    return {
      identifier: scope.environmentId,
    };
  },
  pathMatchers: deploymentApiPaths,
  log: {
    rejections: env.DEPLOYMENT_RATE_LIMIT_REJECTION_LOGS_ENABLED === "1",
    requests: env.DEPLOYMENT_RATE_LIMIT_REQUEST_LOGS_ENABLED === "1",
    limiter: env.DEPLOYMENT_RATE_LIMIT_LIMITER_LOGS_ENABLED === "1",
  },
});
