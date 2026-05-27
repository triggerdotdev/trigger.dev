import { Ratelimit } from "@upstash/ratelimit";
import { env } from "~/env.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiter.server";
import { singleton } from "~/utils/singleton";

export class SsoRateLimitError extends Error {
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("SSO sign-in rate limit exceeded.");
    this.retryAfter = retryAfter;
  }
}

function getRedisClient() {
  return createRedisRateLimitClient({
    port: env.RATE_LIMIT_REDIS_PORT,
    host: env.RATE_LIMIT_REDIS_HOST,
    username: env.RATE_LIMIT_REDIS_USERNAME,
    password: env.RATE_LIMIT_REDIS_PASSWORD,
    tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
    clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
  });
}

const ssoEmailRateLimiter = singleton("ssoEmailRateLimiter", initializeEmailLimiter);
const ssoIpRateLimiter = singleton("ssoIpRateLimiter", initializeIpLimiter);

function initializeEmailLimiter() {
  return new RateLimiter({
    redisClient: getRedisClient(),
    keyPrefix: "auth:sso:email",
    limiter: Ratelimit.slidingWindow(5, "1 m"),
    logSuccess: false,
    logFailure: true,
  });
}

function initializeIpLimiter() {
  return new RateLimiter({
    redisClient: getRedisClient(),
    keyPrefix: "auth:sso:ip",
    limiter: Ratelimit.slidingWindow(20, "1 m"),
    logSuccess: false,
    logFailure: true,
  });
}

export async function checkSsoEmailRateLimit(identifier: string): Promise<void> {
  const result = await ssoEmailRateLimiter.limit(identifier);
  if (!result.success) {
    const retryAfter = new Date(result.reset).getTime() - Date.now();
    throw new SsoRateLimitError(retryAfter);
  }
}

export async function checkSsoIpRateLimit(ip: string): Promise<void> {
  const result = await ssoIpRateLimiter.limit(ip);
  if (!result.success) {
    const retryAfter = new Date(result.reset).getTime() - Date.now();
    throw new SsoRateLimitError(retryAfter);
  }
}
