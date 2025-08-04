import { Ratelimit } from "@upstash/ratelimit";
import { env } from "~/env.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiter.server";
import { singleton } from "~/utils/singleton";

export const mfaRateLimiter = singleton("mfaRateLimiter", initializeMfaRateLimiter);

function initializeMfaRateLimiter() {
  const redisClient = createRedisRateLimitClient({
    port: env.RATE_LIMIT_REDIS_PORT,
    host: env.RATE_LIMIT_REDIS_HOST,
    username: env.RATE_LIMIT_REDIS_USERNAME,
    password: env.RATE_LIMIT_REDIS_PASSWORD,
    tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
    clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
  });

  return new RateLimiter({
    redisClient,
    keyPrefix: "mfa:validation",
    limiter: Ratelimit.slidingWindow(10, "1 m"), // 10 attempts per minute
    logSuccess: false, // Don't log successful attempts for privacy
    logFailure: true, // Log rate limit violations for security monitoring
  });
}

export class MfaRateLimitError extends Error {
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super(`MFA validation rate limit exceeded.`);
    this.retryAfter = retryAfter;
  }
}

/**
 * Check if the user can attempt MFA validation
 * @param userId - The user ID to rate limit
 * @throws {MfaRateLimitError} If rate limit is exceeded
 */
export async function checkMfaRateLimit(userId: string): Promise<void> {
  const result = await mfaRateLimiter.limit(userId);

  if (!result.success) {
    const retryAfter = new Date(result.reset).getTime() - Date.now();
    throw new MfaRateLimitError(retryAfter);
  }
}
