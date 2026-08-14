import { Ratelimit } from "@upstash/ratelimit";
import { type RedisWithClusterOptions } from "~/redis.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiter.server";
import { singleton } from "~/utils/singleton";

// Each row of the profile page now writes to the User row on its own — a switch
// is one click, one write — so there's no submit button pacing the writes any
// more. The client debounces and keeps one write in flight, but that's a
// courtesy a scripted POST skips, and `/account` sits outside `/api/*` so the
// global apiRateLimiter doesn't cover it. Hence a per-user cap here.
//
// Exported so the policy is asserted in tests rather than re-encoded.
export const PROFILE_UPDATE_RATE_LIMIT_ATTEMPTS = 20;
export const PROFILE_UPDATE_RATE_LIMIT_WINDOW = "1 m" as const;

/**
 * Build the profile-update per-user rate limiter. Production uses the
 * env-derived rate-limit Redis; tests inject a container Redis.
 */
export function createProfileUpdateRateLimiter(
  redisOptions?: RedisWithClusterOptions
): RateLimiter {
  return new RateLimiter({
    ...(redisOptions ? { redisClient: createRedisRateLimitClient(redisOptions) } : {}),
    keyPrefix: "account.profile-update",
    limiter: Ratelimit.slidingWindow(
      PROFILE_UPDATE_RATE_LIMIT_ATTEMPTS,
      PROFILE_UPDATE_RATE_LIMIT_WINDOW
    ),
    logFailure: true,
  });
}

export const profileUpdateRateLimiter = singleton("profileUpdateRateLimiter", () =>
  createProfileUpdateRateLimiter()
);
