import { Ratelimit } from "@upstash/ratelimit";
import { env } from "~/env.server";
import type { RedisWithClusterOptions } from "~/redis.server";
import { singleton } from "~/utils/singleton";
import { createRedisRateLimitClient, RateLimiter, type Duration } from "./rateLimiter.server";
import type { RateLimiterRedisClient } from "./rateLimiterCore.server";

export type IngressRateLimit = { tokens: number; windowSeconds: number };

/**
 * A fixed-window limit for the unauthenticated webhook ingress, with the limit the org's plan or back
 * office sets. There is one limiter per distinct limit, all on one Redis connection. They share the
 * window's counter, so a changed limit applies to the tokens already counted in that window.
 */
export function createWebhookIngressRateLimiter(
  redis: RedisWithClusterOptions,
  keyPrefix = "webhook-ingress"
) {
  let client: RateLimiterRedisClient | undefined;
  const limiters = new Map<string, RateLimiter>();

  return {
    limit(identifier: string, { tokens, windowSeconds }: IngressRateLimit, cost = 1) {
      const key = `${tokens}:${windowSeconds}`;
      let limiter = limiters.get(key);
      if (!limiter) {
        client ??= createRedisRateLimitClient(redis);
        limiter = new RateLimiter({
          keyPrefix,
          limiter: Ratelimit.fixedWindow(tokens, `${windowSeconds} s` as Duration),
          redisClient: client,
          logFailure: true,
        });
        limiters.set(key, limiter);
      }
      return limiter.limit(identifier, cost);
    },
  };
}

function rateLimitRedis(): RedisWithClusterOptions {
  return {
    port: env.RATE_LIMIT_REDIS_PORT,
    host: env.RATE_LIMIT_REDIS_HOST,
    username: env.RATE_LIMIT_REDIS_USERNAME,
    password: env.RATE_LIMIT_REDIS_PASSWORD,
    tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
    clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
  };
}

/** Per endpoint, keyed on its opaque id: one token per request. */
export const webhookIngressRateLimiter = singleton("webhookIngressRateLimiter", () =>
  createWebhookIngressRateLimiter(rateLimitRedis())
);

/** Per environment, across all of its endpoints: one token per started 64 KiB of body. */
export const webhookIngressEnvironmentRateLimiter = singleton(
  "webhookIngressEnvironmentRateLimiter",
  () => createWebhookIngressRateLimiter(rateLimitRedis(), "webhook-ingress-env")
);

/** What a request of `bytes` costs against its environment's limit. */
export function webhookIngressTokenCost(bytes: number) {
  return Math.max(1, Math.ceil(bytes / (64 * 1024)));
}

/**
 * Charge the rest of a request's size-based cost to its environment, once `bytes` of its body have
 * been read; admission already charged the first token.
 */
export async function chargeWebhookIngressBody(
  limiter: Pick<ReturnType<typeof createWebhookIngressRateLimiter>, "limit">,
  environment: { id: string; limit: IngressRateLimit },
  bytes: number
): Promise<{ success: boolean; reset: number }> {
  const remaining = webhookIngressTokenCost(bytes) - 1;
  if (remaining <= 0) return { success: true, reset: 0 };
  return limiter.limit(environment.id, environment.limit, remaining);
}
