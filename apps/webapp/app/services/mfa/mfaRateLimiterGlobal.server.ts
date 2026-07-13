import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import {
  checkMfaRateLimit as checkMfaRateLimitWith,
  createMfaRateLimiters,
  type MfaRateLimiters,
} from "./mfaRateLimiter.server";

// Production singletons, wired to the env-derived rate-limit Redis.
// Kept out of `mfaRateLimiter.server.ts` so that module stays free of
// `env.server` and remains testable in isolation (see that file).
const mfaRateLimiters = singleton("mfaRateLimiters", () =>
  createMfaRateLimiters({
    redisOptions: {
      port: env.RATE_LIMIT_REDIS_PORT,
      host: env.RATE_LIMIT_REDIS_HOST,
      username: env.RATE_LIMIT_REDIS_USERNAME,
      password: env.RATE_LIMIT_REDIS_PASSWORD,
      tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
      clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
    },
  })
);

export const mfaRateLimiter = mfaRateLimiters.perMinute;
export const mfaDailyRateLimiter = mfaRateLimiters.daily;

/**
 * Production entrypoint: rate-limit an MFA validation attempt for `userId`
 * against the env-configured limiter pair. Throws `MfaRateLimitError` when
 * either the per-minute or the cumulative daily cap is exceeded.
 */
export function checkMfaRateLimit(userId: string, limiters: MfaRateLimiters = mfaRateLimiters) {
  return checkMfaRateLimitWith(userId, limiters);
}

export { MfaRateLimitError } from "./mfaRateLimiter.server";
