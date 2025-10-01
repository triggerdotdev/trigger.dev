import { createCache, DefaultStatefulContext, Namespace, Cache as UnkeyCache } from "@unkey/cache";
import { MemoryStore } from "@unkey/cache/stores";
import { Ratelimit } from "@upstash/ratelimit";
import { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "~/env.server";
import { RedisWithClusterOptions } from "~/redis.server";
import { logger } from "./logger.server";
import { createRedisRateLimitClient, Duration, RateLimiter } from "./rateLimiter.server";
import { RedisCacheStore } from "./unkey/redisCacheStore.server";

const DurationSchema = z.custom<Duration>((value) => {
  if (typeof value !== "string") {
    throw new Error("Duration must be a string");
  }

  return value as Duration;
});

export const RateLimitFixedWindowConfig = z.object({
  type: z.literal("fixedWindow"),
  window: DurationSchema,
  tokens: z.number(),
});

export type RateLimitFixedWindowConfig = z.infer<typeof RateLimitFixedWindowConfig>;

export const RateLimitSlidingWindowConfig = z.object({
  type: z.literal("slidingWindow"),
  window: DurationSchema,
  tokens: z.number(),
});

export type RateLimitSlidingWindowConfig = z.infer<typeof RateLimitSlidingWindowConfig>;

export const RateLimitTokenBucketConfig = z.object({
  type: z.literal("tokenBucket"),
  refillRate: z.number(),
  interval: DurationSchema,
  maxTokens: z.number(),
});

export type RateLimitTokenBucketConfig = z.infer<typeof RateLimitTokenBucketConfig>;

export const RateLimiterConfig = z.discriminatedUnion("type", [
  RateLimitFixedWindowConfig,
  RateLimitSlidingWindowConfig,
  RateLimitTokenBucketConfig,
]);

export type RateLimiterConfig = z.infer<typeof RateLimiterConfig>;

type LimitConfigOverrideFunction = (authorizationValue: string) => Promise<unknown>;

type Options = {
  redis?: RedisWithClusterOptions;
  keyPrefix: string;
  pathMatchers: (RegExp | string)[];
  pathWhiteList?: (RegExp | string)[];
  defaultLimiter: RateLimiterConfig;
  limiterConfigOverride?: LimitConfigOverrideFunction;
  limiterCache?: {
    fresh: number;
    stale: number;
    maxItems: number;
  };
  log?: {
    requests?: boolean;
    rejections?: boolean;
    limiter?: boolean;
  };
};

async function resolveLimitConfig(
  authorizationValue: string,
  hashedAuthorizationValue: string,
  defaultLimiter: RateLimiterConfig,
  cache: UnkeyCache<{ limiter: RateLimiterConfig }>,
  logsEnabled: boolean,
  limiterConfigOverride?: LimitConfigOverrideFunction
): Promise<RateLimiterConfig> {
  if (!limiterConfigOverride) {
    return defaultLimiter;
  }

  if (logsEnabled) {
    logger.info("RateLimiter: checking for override", {
      authorizationValue: hashedAuthorizationValue,
      defaultLimiter,
    });
  }

  const cacheResult = await cache.limiter.swr(hashedAuthorizationValue, async (key) => {
    const override = await limiterConfigOverride(authorizationValue);

    if (!override) {
      if (logsEnabled) {
        logger.info("RateLimiter: no override found", {
          authorizationValue,
          defaultLimiter,
        });
      }

      return defaultLimiter;
    }

    const parsedOverride = RateLimiterConfig.safeParse(override);

    if (!parsedOverride.success) {
      logger.error("Error parsing rate limiter override", {
        override,
        errors: parsedOverride.error.errors,
      });

      return defaultLimiter;
    }

    if (logsEnabled && parsedOverride.data) {
      logger.info("RateLimiter: override found", {
        authorizationValue,
        defaultLimiter,
        override: parsedOverride.data,
      });
    }

    return parsedOverride.data;
  });

  return cacheResult.val ?? defaultLimiter;
}

//returns an Express middleware that rate limits using the Bearer token in the Authorization header
export function authorizationRateLimitMiddleware({
  redis,
  keyPrefix,
  defaultLimiter,
  pathMatchers,
  pathWhiteList = [],
  log = {
    rejections: true,
    requests: true,
  },
  limiterCache,
  limiterConfigOverride,
}: Options) {
  const ctx = new DefaultStatefulContext();
  const memory = new MemoryStore({
    persistentMap: new Map(),
    unstableEvictOnSet: { frequency: 0.001, maxItems: limiterCache?.maxItems ?? 1000 },
  });
  const redisCacheStore = new RedisCacheStore({
    connection: {
      keyPrefix: `cache:${keyPrefix}:rate-limit-cache:`,
      ...redis,
    },
  });

  // This cache holds the rate limit configuration for each org, so we don't have to fetch it every request
  const cache = createCache({
    limiter: new Namespace<RateLimiterConfig>(ctx, {
      stores: [memory, redisCacheStore],
      fresh: limiterCache?.fresh ?? 30_000,
      stale: limiterCache?.stale ?? 60_000,
    }),
  });

  const redisClient = createRedisRateLimitClient(
    redis ?? {
      port: env.RATE_LIMIT_REDIS_PORT,
      host: env.RATE_LIMIT_REDIS_HOST,
      username: env.RATE_LIMIT_REDIS_USERNAME,
      password: env.RATE_LIMIT_REDIS_PASSWORD,
      tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
      clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
    }
  );

  return async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    if (log.requests) {
      logger.info(`RateLimiter (${keyPrefix}): request to ${req.path}`);
    }

    // allow OPTIONS requests
    if (req.method.toUpperCase() === "OPTIONS") {
      return next();
    }

    //first check if any of the pathMatchers match the request path
    const path = req.path;
    if (
      !pathMatchers.some((matcher) =>
        matcher instanceof RegExp ? matcher.test(path) : path === matcher
      )
    ) {
      if (log.requests) {
        logger.info(`RateLimiter (${keyPrefix}): didn't match ${req.path}`);
      }
      return next();
    }

    // Check if the path matches any of the whitelisted paths
    if (
      pathWhiteList.some((matcher) =>
        matcher instanceof RegExp ? matcher.test(path) : path === matcher
      )
    ) {
      if (log.requests) {
        logger.info(`RateLimiter (${keyPrefix}): whitelisted ${req.path}`);
      }
      return next();
    }

    if (log.requests) {
      logger.info(`RateLimiter (${keyPrefix}): matched ${req.path}`);
    }

    const authorizationValue = req.headers.authorization;
    if (!authorizationValue) {
      if (log.requests) {
        logger.info(`RateLimiter (${keyPrefix}): no key`, { headers: req.headers, url: req.url });
      }
      res.setHeader("Content-Type", "application/problem+json");
      return res.status(401).send(
        JSON.stringify(
          {
            title: "Unauthorized",
            status: 401,
            type: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/401",
            detail: "No authorization header provided",
            error: "No authorization header provided",
          },
          null,
          2
        )
      );
    }

    const hash = createHash("sha256");
    hash.update(authorizationValue);
    const hashedAuthorizationValue = hash.digest("hex");

    const limiterConfig = await resolveLimitConfig(
      authorizationValue,
      hashedAuthorizationValue,
      defaultLimiter,
      cache,
      typeof log.limiter === "boolean" ? log.limiter : false,
      limiterConfigOverride
    );

    const limiter =
      limiterConfig.type === "fixedWindow"
        ? Ratelimit.fixedWindow(limiterConfig.tokens, limiterConfig.window)
        : limiterConfig.type === "tokenBucket"
        ? Ratelimit.tokenBucket(
            limiterConfig.refillRate,
            limiterConfig.interval,
            limiterConfig.maxTokens
          )
        : Ratelimit.slidingWindow(limiterConfig.tokens, limiterConfig.window);

    const rateLimiter = new RateLimiter({
      redisClient,
      keyPrefix,
      limiter,
      logSuccess: log.requests,
      logFailure: log.rejections,
    });

    const { success, limit, reset, remaining } = await rateLimiter.limit(hashedAuthorizationValue);

    const $remaining = Math.max(0, remaining); // remaining can be negative if the user has exceeded the limit, so clamp it to 0

    res.set("x-ratelimit-limit", limit.toString());
    res.set("x-ratelimit-remaining", $remaining.toString());
    res.set("x-ratelimit-reset", reset.toString());

    if (success) {
      return next();
    }

    res.setHeader("Content-Type", "application/problem+json");
    const secondsUntilReset = Math.max(0, (reset - new Date().getTime()) / 1000);
    return res.status(429).send(
      JSON.stringify(
        {
          title: "Rate Limit Exceeded",
          status: 429,
          type: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429",
          detail: `Rate limit exceeded ${$remaining}/${limit} requests remaining. Retry in ${secondsUntilReset} seconds.`,
          reset,
          limit,
          remaining,
          secondsUntilReset,
          error: `Rate limit exceeded ${$remaining}/${limit} requests remaining. Retry in ${secondsUntilReset} seconds.`,
        },
        null,
        2
      )
    );
  };
}

export type RateLimitMiddleware = ReturnType<typeof authorizationRateLimitMiddleware>;
