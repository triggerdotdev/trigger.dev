import { Ratelimit } from "@upstash/ratelimit";
import { type RedisWithClusterOptions } from "~/redis.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiterCore.server";

// MFA rate limiting: two sliding windows in series, both of which must pass.
// A per-minute window covers interactive retries; a cumulative daily window
// caps total attempts per pending-MFA session.
//
// Free of `env.server` so it can be tested directly against a container Redis;
// the env-derived production singletons live in `mfaRateLimiterGlobal.server.ts`.

// Production policy. Exported so tests assert against the real numbers.
export const MFA_PER_MINUTE_ATTEMPTS = 5;
export const MFA_DAILY_ATTEMPTS = 30;

export type MfaRateLimiters = {
  perMinute: Pick<RateLimiter, "limit">;
  daily: Pick<RateLimiter, "limit">;
};

/**
 * Build the pair of MFA rate limiters. Production passes the env-derived
 * Redis connection and the default policy; tests inject a container
 * Redis (and may override the attempt caps to isolate one window).
 */
export function createMfaRateLimiters(options: {
  redisOptions: RedisWithClusterOptions;
  perMinuteAttempts?: number;
  dailyAttempts?: number;
}): { perMinute: RateLimiter; daily: RateLimiter } {
  const redisClient = createRedisRateLimitClient(options.redisOptions);

  return {
    perMinute: new RateLimiter({
      redisClient,
      keyPrefix: "mfa:validation",
      limiter: Ratelimit.slidingWindow(options.perMinuteAttempts ?? MFA_PER_MINUTE_ATTEMPTS, "1 m"),
      logSuccess: false,
      logFailure: true,
    }),
    daily: new RateLimiter({
      redisClient,
      keyPrefix: "mfa:validation:daily",
      limiter: Ratelimit.slidingWindow(options.dailyAttempts ?? MFA_DAILY_ATTEMPTS, "24 h"),
      logSuccess: false,
      logFailure: true,
    }),
  };
}

export class MfaRateLimitError extends Error {
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super(`MFA validation rate limit exceeded.`);
    this.retryAfter = retryAfter;
  }
}

/**
 * Check whether the user can attempt MFA validation, enforcing both the
 * per-minute and the daily cap. The daily cap is checked first.
 * @param userId - The user ID to rate limit
 * @param limiters - The limiter pair (production singletons or test-injected)
 * @throws {MfaRateLimitError} If either rate limit is exceeded
 */
export async function checkMfaRateLimit(userId: string, limiters: MfaRateLimiters): Promise<void> {
  const dailyResult = await limiters.daily.limit(userId);
  if (!dailyResult.success) {
    const retryAfter = new Date(dailyResult.reset).getTime() - Date.now();
    throw new MfaRateLimitError(retryAfter);
  }

  const result = await limiters.perMinute.limit(userId);
  if (!result.success) {
    const retryAfter = new Date(result.reset).getTime() - Date.now();
    throw new MfaRateLimitError(retryAfter);
  }
}
