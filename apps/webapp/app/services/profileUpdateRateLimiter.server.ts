import { Ratelimit } from "@upstash/ratelimit";
import { type RedisWithClusterOptions } from "~/redis.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiter.server";
import { singleton } from "~/utils/singleton";

// Every profile row writes on its own, with no submit button pacing them. The
// client debounce is a courtesy a scripted POST skips, and `/account` sits
// outside `/api/*` so apiRateLimiter doesn't cover it. Exported for the tests.
const PROFILE_UPDATE_RATE_LIMIT_ATTEMPTS = 20;
const PROFILE_UPDATE_RATE_LIMIT_WINDOW = "1 m" as const;

/** Production uses the env-derived Redis; tests inject a container one. */
function createProfileUpdateRateLimiter(redisOptions?: RedisWithClusterOptions): RateLimiter {
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
