import { Ratelimit } from "@upstash/ratelimit";
import { authorizationRateLimitMiddleware } from "./apiRateLimit.server";
import { Duration } from "./rateLimiter.server";
import { env } from "~/env.server";

export const realtimeRequestRateLimiter = authorizationRateLimitMiddleware({
  keyPrefix: "realtime",
  limiter: Ratelimit.fixedWindow(
    env.REALTIME_RATE_LIMIT_TOKENS,
    env.REALTIME_RATE_LIMIT_WINDOW as Duration
  ),
  pathMatchers: [/^\/realtime/],
  log: {
    rejections: env.REALTIME_RATE_LIMIT_REJECTION_LOGS_ENABLED === "1",
    requests: env.REALTIME_RATE_LIMIT_REQUEST_LOGS_ENABLED === "1",
  },
});
