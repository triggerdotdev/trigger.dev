import { Ratelimit } from "@upstash/ratelimit";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiter.server";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { singleton } from "~/utils/singleton";

type LimitName = "register" | "cimd" | "token" | "revoke" | "mcp";

export const OAUTH_IP_LIMITS: Record<LimitName, number> = {
  register: 30,
  cimd: 30,
  token: 60,
  revoke: 30,
  mcp: 120,
};

function ipRateLimiter(name: LimitName) {
  return singleton(
    `oauth-${name}-ip-rate-limiter`,
    () =>
      new RateLimiter({
        redisClient: createRedisRateLimitClient({
          port: env.RATE_LIMIT_REDIS_PORT,
          host: env.RATE_LIMIT_REDIS_HOST,
          username: env.RATE_LIMIT_REDIS_USERNAME,
          password: env.RATE_LIMIT_REDIS_PASSWORD,
          tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
          clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
        }),
        keyPrefix: `auth:oauth:${name}:ip`,
        limiter: Ratelimit.slidingWindow(OAUTH_IP_LIMITS[name], "1 m"),
        logSuccess: false,
        logFailure: true,
      })
  );
}

type Limit = (key: string) => Promise<{ success: boolean; reset: number }>;

/**
 * Seconds until the caller may try again, or null when it is within the limit. Requests without
 * a client IP share one bucket rather than going unlimited.
 */
export async function checkOAuthIpRateLimit(
  name: LimitName,
  request: Request,
  limit: Limit = (key) => ipRateLimiter(name).limit(key)
): Promise<number | null> {
  let result: Awaited<ReturnType<Limit>>;
  try {
    result = await limit(extractClientIp(request.headers.get("x-forwarded-for")) ?? "unknown");
  } catch (error) {
    logger.warn("oauth.ratelimit.unavailable", { name, error });
    return null;
  }
  if (result.success) return null;
  return Math.max(1, Math.ceil((new Date(result.reset).getTime() - Date.now()) / 1000));
}
