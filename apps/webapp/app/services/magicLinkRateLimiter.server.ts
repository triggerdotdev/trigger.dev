import { Ratelimit } from "@upstash/ratelimit";
import { env } from "~/env.server";
import { createRedisRateLimitClient, RateLimiter } from "~/services/rateLimiter.server";
import { singleton } from "~/utils/singleton";

export class MagicLinkRateLimitError extends Error {
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("Magic link request rate limit exceeded.");
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

const magicLinkEmailRateLimiter = singleton(
  "magicLinkEmailRateLimiter",
  initializeMagicLinkEmailRateLimiter
);

function initializeMagicLinkEmailRateLimiter() {
  return new RateLimiter({
    redisClient: getRedisClient(),
    keyPrefix: "auth:magiclink:email",
    limiter: Ratelimit.slidingWindow(3, "1 m"), // 3 requests per minute per email
    logSuccess: false,
    logFailure: true,
  });
}

const magicLinkEmailDailyRateLimiter = singleton(
  "magicLinkEmailDailyRateLimiter",
  initializeMagicLinkEmailDailyRateLimiter
);

function initializeMagicLinkEmailDailyRateLimiter() {
  return new RateLimiter({
    redisClient: getRedisClient(),
    keyPrefix: "auth:magiclink:email:daily",
    limiter: Ratelimit.slidingWindow(30, "1 d"), // 30 requests per day per email
    logSuccess: false,
    logFailure: true,
  });
}

const magicLinkIpRateLimiter = singleton(
  "magicLinkIpRateLimiter",
  initializeMagicLinkIpRateLimiter
);

function initializeMagicLinkIpRateLimiter() {
  return new RateLimiter({
    redisClient: getRedisClient(),
    keyPrefix: "auth:magiclink:ip",
    limiter: Ratelimit.slidingWindow(10, "1 m"), // 10 requests per minute per IP
    logSuccess: false,
    logFailure: true,
  });
}

/**
 * Canonicalize an email address for rate-limit keying so address variants
 * that resolve to the same inbox share one bucket: lowercase, strip any
 * `+tag` subaddress, and (for Gmail domains, which ignore dots in the local
 * part) remove `.` from the local part. Use only for the limiter key —
 * delivery must always use the raw submitted address.
 */
export function canonicalizeEmailForRateLimit(email: string): string {
  const atIndex = email.lastIndexOf("@");
  if (atIndex < 1) {
    return email.toLowerCase();
  }

  const localPart = email.slice(0, atIndex).toLowerCase();
  const domain = email.slice(atIndex + 1).toLowerCase();

  const withoutTag = localPart.split("+")[0];

  // Gmail (and Google Workspace on gmail.com/googlemail.com) ignores dots in
  // the local part; other providers treat them as distinct addresses.
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${withoutTag.replaceAll(".", "")}@gmail.com`;
  }

  return `${withoutTag}@${domain}`;
}

export async function checkMagicLinkEmailRateLimit(identifier: string): Promise<void> {
  const result = await magicLinkEmailRateLimiter.limit(identifier);

  if (!result.success) {
    const retryAfter = new Date(result.reset).getTime() - Date.now();
    throw new MagicLinkRateLimitError(retryAfter);
  }
}

export async function checkMagicLinkEmailDailyRateLimit(identifier: string): Promise<void> {
  const result = await magicLinkEmailDailyRateLimiter.limit(identifier);

  if (!result.success) {
    const retryAfter = new Date(result.reset).getTime() - Date.now();
    throw new MagicLinkRateLimitError(retryAfter);
  }
}

export async function checkMagicLinkIpRateLimit(ip: string): Promise<void> {
  const result = await magicLinkIpRateLimiter.limit(ip);

  if (!result.success) {
    const retryAfter = new Date(result.reset).getTime() - Date.now();
    throw new MagicLinkRateLimitError(retryAfter);
  }
}
