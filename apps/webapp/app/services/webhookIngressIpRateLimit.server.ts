import { Ratelimit } from "@upstash/ratelimit";
import { LRUCache } from "lru-cache";
import { env } from "~/env.server";
import type { RedisWithClusterOptions } from "~/redis.server";
import { singleton } from "~/utils/singleton";
import { logger } from "./logger.server";
import { RateLimiter, type Duration } from "./rateLimiter.server";

export type WebhookIngressIpLimitResult =
  | { success: true }
  | { success: false; retryAfterSeconds: number };

/**
 * Per-IP budget for ingress requests to endpoint ids that don't exist, so one source can't flood the
 * ingress with made-up ids. A request to a real endpoint never spends it: that endpoint's own limit
 * bounds it, so a provider IP shared by many customers is never throttled by another customer's
 * traffic. Callers pass the last X-Forwarded-For hop, which the load balancer appends; a request
 * without one isn't limited, and a limiter failure lets the request through. Each process remembers
 * an IP that used up its budget until the window resets, so `blockedFor` can refuse it before any
 * other work. A blocked IP can still reach a real endpoint the process hasn't cached yet: each
 * blocked IP gets its own small lookup budget (`takeBlockedLookup`), so made-up ids cost at most
 * that many database reads per second per source, and one source can't spend another's.
 */
export function createWebhookIngressIpRateLimiter(options: {
  tokens: number;
  window: Duration;
  redis?: RedisWithClusterOptions;
  blockedLookupsPerSecond?: number;
}) {
  const limiter = new RateLimiter({
    keyPrefix: "webhook-ingress-ip",
    limiter: Ratelimit.fixedWindow(options.tokens, options.window),
    logFailure: false,
    redis: options.redis,
  });
  const blockedUntil = new LRUCache<string, number>({ max: 10_000 });
  const lookupsPerSecond = options.blockedLookupsPerSecond ?? 5;
  const lookupBuckets = new LRUCache<string, { tokens: number; refilledAt: number }>({
    max: 10_000,
  });

  return {
    /** Whether this process may look up an uncached endpoint id for blocked `ip` right now. */
    takeBlockedLookup(ip: string): boolean {
      const now = Date.now();
      const bucket = lookupBuckets.get(ip) ?? { tokens: lookupsPerSecond, refilledAt: now };
      const tokens = Math.min(
        lookupsPerSecond,
        bucket.tokens + ((now - bucket.refilledAt) / 1000) * lookupsPerSecond
      );
      const taken = tokens >= 1;
      lookupBuckets.set(ip, { tokens: taken ? tokens - 1 : tokens, refilledAt: now });
      return taken;
    },
    /** Seconds until `ip` may send requests for unknown endpoints again, or undefined if it may now. */
    blockedFor(ip: string | null | undefined): number | undefined {
      if (!ip) return undefined;
      const until = blockedUntil.get(ip);
      if (until === undefined) return undefined;
      const now = Date.now();
      if (until <= now) {
        blockedUntil.delete(ip);
        return undefined;
      }
      return Math.max(1, Math.ceil((until - now) / 1000));
    },
    async limit(ip: string | null | undefined): Promise<WebhookIngressIpLimitResult> {
      if (!ip) return { success: true };
      try {
        const result = await limiter.limit(ip);
        if (result.success) return { success: true };
        blockedUntil.set(ip, result.reset);
        return {
          success: false,
          retryAfterSeconds: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
        };
      } catch (error) {
        logger.warn("webhookIngressIpRateLimiter: limiter error, allowing request", { error });
        return { success: true };
      }
    },
  };
}

export const webhookIngressIpRateLimiter = singleton("webhookIngressIpRateLimiter", () =>
  createWebhookIngressIpRateLimiter({
    tokens: env.WEBHOOK_INGRESS_IP_RATE_LIMIT_TOKENS,
    window: env.WEBHOOK_INGRESS_IP_RATE_LIMIT_WINDOW as Duration,
  })
);
