import { env } from "~/env.server";
import { authenticateAuthorizationHeader } from "./apiAuth.server";
import { authorizationRateLimitMiddleware } from "./authorizationRateLimitMiddleware.server";
import { Duration } from "./rateLimiter.server";

export const apiRateLimiter = authorizationRateLimitMiddleware({
  redis: {
    port: env.RATE_LIMIT_REDIS_PORT,
    host: env.RATE_LIMIT_REDIS_HOST,
    username: env.RATE_LIMIT_REDIS_USERNAME,
    password: env.RATE_LIMIT_REDIS_PASSWORD,
    tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
    clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
  },
  keyPrefix: "api",
  defaultLimiter: {
    type: "tokenBucket",
    refillRate: env.API_RATE_LIMIT_REFILL_RATE,
    interval: env.API_RATE_LIMIT_REFILL_INTERVAL as Duration,
    maxTokens: env.API_RATE_LIMIT_MAX,
  },
  limiterCache: {
    fresh: 60_000 * 10, // Data is fresh for 10 minutes
    stale: 60_000 * 20, // Date is stale after 20 minutes
    maxItems: 1000,
  },
  limiterConfigOverride: async (authorizationValue) => {
    const authenticatedEnv = await authenticateAuthorizationHeader(authorizationValue, {
      allowPublicKey: true,
      allowJWT: true,
    });

    if (!authenticatedEnv || !authenticatedEnv.ok) {
      return;
    }

    if (authenticatedEnv.type === "PUBLIC_JWT") {
      return {
        type: "fixedWindow",
        window: env.API_RATE_LIMIT_JWT_WINDOW,
        tokens: env.API_RATE_LIMIT_JWT_TOKENS,
      };
    } else {
      return authenticatedEnv.environment.organization.apiRateLimiterConfig;
    }
  },
  pathMatchers: [/^\/api/],
  // Allow /api/v1/tasks/:id/callback/:secret
  pathWhiteList: [
    "/api/internal/stripe_webhooks",
    "/api/v1/authorization-code",
    "/api/v1/token",
    "/api/v1/usage/ingest",
    /^\/api\/v1\/tasks\/[^\/]+\/callback\/[^\/]+$/, // /api/v1/tasks/$id/callback/$secret
    /^\/api\/v1\/runs\/[^\/]+\/tasks\/[^\/]+\/callback\/[^\/]+$/, // /api/v1/runs/$runId/tasks/$id/callback/$secret
    /^\/api\/v1\/http-endpoints\/[^\/]+\/env\/[^\/]+\/[^\/]+$/, // /api/v1/http-endpoints/$httpEndpointId/env/$envType/$shortcode
    /^\/api\/v1\/sources\/http\/[^\/]+$/, // /api/v1/sources/http/$id
    /^\/api\/v1\/endpoints\/[^\/]+\/[^\/]+\/index\/[^\/]+$/, // /api/v1/endpoints/$environmentId/$endpointSlug/index/$indexHookIdentifier
    "/api/v1/timezones",
    "/api/v1/usage/ingest",
    "/api/v1/auth/jwt/claims",
    /^\/api\/v1\/runs\/[^\/]+\/attempts$/, // /api/v1/runs/$runFriendlyId/attempts
    /^\/api\/v1\/waitpoints\/tokens\/[^\/]+\/callback\/[^\/]+$/, // /api/v1/waitpoints/tokens/$waitpointFriendlyId/callback/$hash
  ],
  log: {
    rejections: env.API_RATE_LIMIT_REJECTION_LOGS_ENABLED === "1",
    requests: env.API_RATE_LIMIT_REQUEST_LOGS_ENABLED === "1",
    limiter: env.API_RATE_LIMIT_LIMITER_LOGS_ENABLED === "1",
  },
});

export type RateLimitMiddleware = ReturnType<typeof authorizationRateLimitMiddleware>;
