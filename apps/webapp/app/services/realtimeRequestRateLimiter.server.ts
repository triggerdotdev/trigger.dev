import { env } from "~/env.server";
import { authenticateAuthorizationHeader } from "./apiAuth.server";
import { authorizationRateLimitMiddleware } from "./apiRateLimit.server";
import { Duration } from "./rateLimiter.server";

export const realtimeRequestRateLimiter = authorizationRateLimitMiddleware({
  keyPrefix: "realtime",
  defaultLimiter: {
    type: "fixedWindow",
    tokens: env.REALTIME_RATE_LIMIT_TOKENS,
    window: env.REALTIME_RATE_LIMIT_WINDOW as Duration,
  },
  limiterCache: {
    fresh: 60_000 * 10, // Data is fresh for 10 minutes
    stale: 60_000 * 20, // Date is stale after 20 minutes
  },
  limiterConfigOverride: async (authorizationValue) => {
    const authenticatedEnv = await authenticateAuthorizationHeader(authorizationValue);

    if (!authenticatedEnv) {
      return;
    }

    return authenticatedEnv.environment.organization.realtimeRateLimiterConfig;
  },
  pathMatchers: [/^\/realtime/],
  log: {
    rejections: env.REALTIME_RATE_LIMIT_REJECTION_LOGS_ENABLED === "1",
    requests: env.REALTIME_RATE_LIMIT_REQUEST_LOGS_ENABLED === "1",
    limiter: env.REALTIME_RATE_LIMIT_LIMITER_LOGS_ENABLED === "1",
  },
});
