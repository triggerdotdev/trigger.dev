import { Ratelimit } from "@upstash/ratelimit";
import { env } from "~/env.server";
import type { RedisWithClusterOptions } from "~/redis.server";
import { singleton } from "~/utils/singleton";
import { createRedisRateLimitClient, RateLimiter, type Duration } from "./rateLimiter.server";
import type { RateLimiterRedisClient } from "./rateLimiterCore.server";

export type EndpointRateLimit = { tokens: number; windowSeconds: number };

/**
 * Per-endpoint fixed-window limit for the unauthenticated webhook ingress, keyed on the endpoint's
 * opaque id, with the limit its org's plan or back office sets. There is one limiter per distinct
 * limit, all on one Redis connection. They share the window's counter, so a changed limit applies to
 * the requests already counted in that window.
 */
export function createWebhookIngressRateLimiter(redis: RedisWithClusterOptions) {
  let client: RateLimiterRedisClient | undefined;
  const limiters = new Map<string, RateLimiter>();

  return {
    limit(opaqueId: string, { tokens, windowSeconds }: EndpointRateLimit) {
      const key = `${tokens}:${windowSeconds}`;
      let limiter = limiters.get(key);
      if (!limiter) {
        client ??= createRedisRateLimitClient(redis);
        limiter = new RateLimiter({
          keyPrefix: "webhook-ingress",
          limiter: Ratelimit.fixedWindow(tokens, `${windowSeconds} s` as Duration),
          redisClient: client,
          logFailure: true,
        });
        limiters.set(key, limiter);
      }
      return limiter.limit(opaqueId);
    },
  };
}

export const webhookIngressRateLimiter = singleton("webhookIngressRateLimiter", () =>
  createWebhookIngressRateLimiter({
    port: env.RATE_LIMIT_REDIS_PORT,
    host: env.RATE_LIMIT_REDIS_HOST,
    username: env.RATE_LIMIT_REDIS_USERNAME,
    password: env.RATE_LIMIT_REDIS_PASSWORD,
    tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
    clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
  })
);
