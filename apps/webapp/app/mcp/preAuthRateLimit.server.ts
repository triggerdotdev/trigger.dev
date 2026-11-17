import { Ratelimit } from "@upstash/ratelimit";
import type { Request as ExpressRequest, RequestHandler } from "express";
import type { RedisWithClusterOptions } from "~/redis.server";
import { logger } from "~/services/logger.server";
import { OAUTH_IP_LIMITS } from "~/services/oauth/rateLimit.server";
import { RateLimiter } from "~/services/rateLimiterCore.server";
import { extractClientIp } from "~/utils/extractClientIp.server";

const MCP_PREAUTH_IP_LIMIT = OAUTH_IP_LIMITS.mcp;
const REDIS_TIMEOUT_MS = 500;

type PreAuthOptions = {
  redis: RedisWithClusterOptions;
  limit?: number;
};

export type McpPreAuthRateLimit = {
  gate: RequestHandler;
  recordFailure: (req: ExpressRequest) => Promise<void>;
};

// Hash tag keeps both sliding-window keys in one cluster slot.
const clientIp = (req: ExpressRequest) =>
  `{${extractClientIp(req.get("x-forwarded-for") ?? null) ?? req.ip ?? "unknown"}}`;

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("rate limiter timeout")), REDIS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Counts only failed authentications per IP, so forged tokens cannot cost unlimited DB lookups.
export function createMcpPreAuthRateLimit(options: PreAuthOptions): McpPreAuthRateLimit {
  const limiter = new RateLimiter({
    redis: options.redis,
    keyPrefix: "auth:mcp:preauth:ip",
    limiter: Ratelimit.slidingWindow(options.limit ?? MCP_PREAUTH_IP_LIMIT, "1 m"),
    timeoutMs: REDIS_TIMEOUT_MS,
    logSuccess: false,
    logFailure: true,
  });

  return {
    gate: async (req, res, next) => {
      try {
        if ((await withTimeout(limiter.getRemaining(clientIp(req)))) <= 0) {
          res.set("Retry-After", "60").status(429).json({ error: "Too many requests" });
          return;
        }
      } catch (error) {
        logger.warn("oauth.ratelimit.unavailable", { name: "mcp-preauth", error });
      }
      next();
    },
    recordFailure: async (req) => {
      try {
        await withTimeout(limiter.limit(clientIp(req)));
      } catch (error) {
        logger.warn("oauth.ratelimit.unavailable", { name: "mcp-preauth", error });
      }
    },
  };
}
