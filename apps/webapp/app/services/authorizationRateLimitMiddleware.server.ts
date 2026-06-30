import type { Cache as UnkeyCache } from "@unkey/cache";
import { createCache, DefaultStatefulContext, Namespace } from "@unkey/cache";
import { createLRUMemoryStore } from "@internal/cache";
import { Ratelimit } from "@upstash/ratelimit";
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from "express";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { RedisWithClusterOptions } from "~/redis.server";
import { logger } from "./logger.server";
import type { Duration, Limiter } from "./rateLimiter.server";
import { createRedisRateLimitClient, RateLimiter } from "./rateLimiter.server";
import { RedisCacheStore } from "./unkey/redisCacheStore.server";

const DurationSchema = z.custom<Duration>((value) => {
  if (typeof value !== "string") {
    throw new Error("Duration must be a string");
  }

  return value as Duration;
});

const RateLimitFixedWindowConfig = z.object({
  type: z.literal("fixedWindow"),
  window: DurationSchema,
  tokens: z.number(),
});

type RateLimitFixedWindowConfig = z.infer<typeof RateLimitFixedWindowConfig>;

const RateLimitSlidingWindowConfig = z.object({
  type: z.literal("slidingWindow"),
  window: DurationSchema,
  tokens: z.number(),
});

type RateLimitSlidingWindowConfig = z.infer<typeof RateLimitSlidingWindowConfig>;

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

type RateLimitOverride = {
  config?: unknown;
  identifier?: string;
};

type LimitConfigOverrideFunction = (
  authorizationValue: string
) => Promise<RateLimitOverride | undefined>;

type Options = {
  redis: RedisWithClusterOptions;
  keyPrefix: string;
  pathMatchers: (RegExp | string)[];
  pathWhiteList?: (RegExp | string)[];
  /**
   * Escape hatch for requests that can only be admitted by consulting state, rather than by
   * matching a path. Runs after the authorization header check, so an unauthenticated
   * request is still rejected, and only skips the rate limit itself. Must not throw: a
   * bypass that cannot decide should return false and let the limiter apply.
   */
  bypass?: (req: ExpressRequest) => Promise<boolean>;
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

type ResolvedRateLimit = {
  config: RateLimiterConfig;
  // Bucket key to use, or undefined to fall back to the hashed Authorization header.
  identifier?: string;
};

async function resolveRateLimit(
  authorizationValue: string,
  hashedAuthorizationValue: string,
  defaultLimiter: RateLimiterConfig,
  cache: UnkeyCache<{ limiter: ResolvedRateLimit }>,
  logsEnabled: boolean,
  limiterConfigOverride?: LimitConfigOverrideFunction
): Promise<ResolvedRateLimit> {
  if (!limiterConfigOverride) {
    return { config: defaultLimiter };
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

      return { config: defaultLimiter } satisfies ResolvedRateLimit;
    }

    const identifier = override.identifier;

    if (!override.config) {
      return { config: defaultLimiter, identifier } satisfies ResolvedRateLimit;
    }

    const parsedOverride = RateLimiterConfig.safeParse(override.config);

    if (!parsedOverride.success) {
      logger.error("Error parsing rate limiter override", {
        override,
        errors: parsedOverride.error.issues,
      });

      return { config: defaultLimiter, identifier } satisfies ResolvedRateLimit;
    }

    if (logsEnabled && parsedOverride.data) {
      logger.info("RateLimiter: override found", {
        authorizationValue,
        defaultLimiter,
        override: parsedOverride.data,
      });
    }

    return { config: parsedOverride.data, identifier } satisfies ResolvedRateLimit;
  });

  // Defensive read: the cache is keyed on a shared Redis namespace, so during a
  // deploy an entry could have been written by a server running a different
  // code version (a different stored shape). Re-validate here so a stale/foreign
  // entry can never reach createLimiterFromConfig with an undefined config and
  // throw. The cache key is also versioned (see RedisCacheStore keyPrefix), so
  // this is belt-and-suspenders.
  const cached = cacheResult.val;
  const parsedConfig = RateLimiterConfig.safeParse(cached?.config);

  return {
    config: parsedConfig.success ? parsedConfig.data : defaultLimiter,
    identifier: typeof cached?.identifier === "string" ? cached.identifier : undefined,
  };
}

/**
 * Creates a Ratelimit limiter from a RateLimiterConfig.
 * This function is shared across the codebase to ensure consistent limiter creation.
 */
export function createLimiterFromConfig(config: RateLimiterConfig): Limiter {
  return config.type === "fixedWindow"
    ? Ratelimit.fixedWindow(config.tokens, config.window)
    : config.type === "tokenBucket"
      ? Ratelimit.tokenBucket(config.refillRate, config.interval, config.maxTokens)
      : Ratelimit.slidingWindow(config.tokens, config.window);
}

//returns an Express middleware that rate limits using the Bearer token in the Authorization header
export function authorizationRateLimitMiddleware({
  redis,
  keyPrefix,
  defaultLimiter,
  pathMatchers,
  pathWhiteList = [],
  bypass,
  log = {
    rejections: true,
    requests: true,
  },
  limiterCache,
  limiterConfigOverride,
}: Options) {
  const ctx = new DefaultStatefulContext();
  const memory = createLRUMemoryStore(limiterCache?.maxItems ?? 1000);
  const redisCacheStore = new RedisCacheStore({
    connection: {
      // Versioned namespace: the cached value shape is part of this key. Bump
      // the version whenever ResolvedRateLimit changes so a rolling deploy never
      // reads entries written in a previous shape (and vice versa).
      keyPrefix: `cache:${keyPrefix}:rate-limit-cache:v2:`,
      ...redis,
    },
  });

  // This cache holds the rate limit configuration for each org, so we don't have to fetch it every request
  const cache = createCache({
    limiter: new Namespace<ResolvedRateLimit>(ctx, {
      stores: [memory, redisCacheStore],
      fresh: limiterCache?.fresh ?? 30_000,
      stale: limiterCache?.stale ?? 60_000,
    }),
  });

  const redisClient = createRedisRateLimitClient(redis);

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

    if (bypass) {
      let bypassed = false;

      try {
        bypassed = await bypass(req);
      } catch (error) {
        logger.warn(`RateLimiter (${keyPrefix}): bypass threw, applying the limit`, {
          path: req.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (bypassed) {
        if (log.requests) {
          logger.info(`RateLimiter (${keyPrefix}): bypassed ${req.path}`);
        }
        return next();
      }
    }

    const hash = createHash("sha256");
    hash.update(authorizationValue);
    const hashedAuthorizationValue = hash.digest("hex");

    const { config: limiterConfig, identifier } = await resolveRateLimit(
      authorizationValue,
      hashedAuthorizationValue,
      defaultLimiter,
      cache,
      typeof log.limiter === "boolean" ? log.limiter : false,
      limiterConfigOverride
    );

    const rateLimitIdentifier = identifier ?? hashedAuthorizationValue;

    const limiter = createLimiterFromConfig(limiterConfig);

    const rateLimiter = new RateLimiter({
      redisClient,
      keyPrefix,
      limiter,
      logSuccess: log.requests,
      logFailure: log.rejections,
    });

    const { success, limit, reset, remaining } = await rateLimiter.limit(rateLimitIdentifier);

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
