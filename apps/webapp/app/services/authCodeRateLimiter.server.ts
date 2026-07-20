import { Ratelimit } from "@upstash/ratelimit";
import { createHash } from "node:crypto";
import { env } from "~/env.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiter.server";
import { singleton } from "~/utils/singleton";

/**
 * Rate limiting for the unauthenticated CLI auth-code endpoints
 * (`/api/v1/authorization-code` mint + `/api/v1/token` poll). The global
 * limiter keys on the Authorization header, which these endpoints don't carry,
 * so it can't throttle them — this module does.
 */
export class AuthorizationCodeRateLimitError extends Error {
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("Authorization code rate limit exceeded.");
    this.name = "AuthorizationCodeRateLimitError";
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

// Minting is unauthenticated and a real login mints one code. Cap per IP, with
// headroom for many users behind a shared NAT.
const authorizationCodeMintIpRateLimiter = singleton(
  "authorizationCodeMintIpRateLimiter",
  () =>
    new RateLimiter({
      redisClient: getRedisClient(),
      keyPrefix: "auth:authcode:mint:ip",
      limiter: Ratelimit.slidingWindow(30, "1 m"), // 30 code mints / min / IP
      logSuccess: false,
      logFailure: true,
    })
);

// Keyed by the code, not the IP: the CLI polls this endpoint ~1/s per login, so
// IP-keying would break logins behind a shared NAT. The ~60/min cadence stays
// under the cap. The code is hashed first so it never lands in a Redis key or log.
const authorizationCodeTokenPollRateLimiter = singleton(
  "authorizationCodeTokenPollRateLimiter",
  () =>
    new RateLimiter({
      redisClient: getRedisClient(),
      keyPrefix: "auth:authcode:token:code",
      limiter: Ratelimit.slidingWindow(100, "1 m"), // 100 polls / min / code (CLI polls ~60/min)
      logSuccess: false,
      logFailure: false,
    })
);

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex").slice(0, 32);
}

export async function checkAuthorizationCodeMintRateLimit(ip: string): Promise<void> {
  const result = await authorizationCodeMintIpRateLimiter.limit(ip);

  if (!result.success) {
    const retryAfter = new Date(result.reset).getTime() - Date.now();
    throw new AuthorizationCodeRateLimitError(retryAfter);
  }
}

export async function checkAuthorizationCodeTokenPollRateLimit(
  authorizationCode: string
): Promise<void> {
  const result = await authorizationCodeTokenPollRateLimiter.limit(hashCode(authorizationCode));

  if (!result.success) {
    const retryAfter = new Date(result.reset).getTime() - Date.now();
    throw new AuthorizationCodeRateLimitError(retryAfter);
  }
}
