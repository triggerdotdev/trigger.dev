import { Ratelimit } from "@upstash/ratelimit";
import { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from "express";
import { RedisOptions } from "ioredis";
import { createHash } from "node:crypto";
import { env } from "~/env.server";
import { logger } from "./logger.server";
import { Duration, Limiter, RateLimiter, createRedisRateLimitClient } from "./rateLimiter.server";
import { DefaultStatefulContext, Namespace, createCache } from "@unkey/cache";
import { MemoryStore } from "@unkey/cache/stores";
import { RedisCacheStore } from "./unkey/redisCacheStore.server";
import { Prettify } from "@trigger.dev/core/v3";

type WindowConfig = {
  /**
   * The interval for the window
   */
  interval: Duration;
  /**
   * Maximum number of requests allowed in the window
   */
  maxRequests: number;
};

type LimiterOptions =
  | {
      type: "tokenBucket";
      /**
       * How many tokens are refilled per `interval`
       *
       * An interval of `10s` and refillRate of 5 will cause a new token to be added every 2 seconds.
       */
      refillRate: number;
      /**
       * The interval for the `refillRate`
       */
      interval: Duration;
      /**
       * Maximum number of tokens.
       * A newly created bucket starts with this many tokens.
       * Useful to allow higher burst limits.
       */
      maxTokens: number;
    }
  | {
      type: "leakyBucket";
      /**
       * How many tokens are refilled per `interval`
       *
       * An interval of `10s` and refillRate of 5 will cause a new token to be added every 2 seconds.
       */
      refillRate: number;
      /**
       * The interval for the `refillRate`
       */
      interval: Duration;
      /**
       * Maximum number of tokens.
       * A newly created bucket starts with this many tokens.
       * Useful to allow higher burst limits.
       */
      maxTokens: number;
    }
  | {
      type: "fixedWindow";
      /**
       * The interval for the window
       */
      interval: Duration;
      /**
       * Maximum number of requests allowed in the window
       */
      maxRequests: number;
    };

type TransformUnionToObject<T extends { type: string }> = {
  [K in T["type"]]: Extract<T, { type: K }> extends { type: K } & infer R
    ? Prettify<Omit<R, "type">>
    : never;
};

type TransformedLimiterOptions = TransformUnionToObject<LimiterOptions>;

type Options<TLimiter extends LimiterOptions> = {
  redis?: RedisOptions;
  keyPrefix: string;
  pathMatchers: (RegExp | string)[];
  pathWhiteList?: (RegExp | string)[];
  limiter: TLimiter;
  resolveLimiterConfig?: (
    authorizationValue: string,
    options: TLimiter
  ) => Promise<TransformedLimiterOptions[TLimiter["type"]]>;
  log?: {
    requests?: boolean;
    rejections?: boolean;
  };
};

//returns an Express middleware that rate limits using the Bearer token in the Authorization header
export function authorizationRateLimitMiddleware<TLimiter extends LimiterOptions>({
  redis,
  keyPrefix,
  limiter,
  pathMatchers,
  pathWhiteList = [],
  log = {
    rejections: true,
    requests: true,
  },
  resolveLimiterConfig,
}: Options<TLimiter>) {
  const ctx = new DefaultStatefulContext();
  const memory = new MemoryStore({ persistentMap: new Map() });
  const redisCacheStore = new RedisCacheStore({
    connection: {
      keyPrefix: `${keyPrefix}:rate-limit-cache:`,
      ...redis,
    },
  });

  const tokenBucketNamespace = new Namespace<TransformedLimiterOptions["tokenBucket"]>(ctx, {
    stores: [memory, redisCacheStore],
    fresh: 30_000,
    stale: 60_000,
  });

  const leakyBucketNamespace = new Namespace<TransformedLimiterOptions["leakyBucket"]>(ctx, {
    stores: [memory, redisCacheStore],
    fresh: 30_000,
    stale: 60_000,
  });

  const fixedWindowNamespace = new Namespace<TransformedLimiterOptions["fixedWindow"]>(ctx, {
    stores: [memory, redisCacheStore],
    fresh: 30_000,
    stale: 60_000,
  });

  const cache = createCache({
    tokenBucket: tokenBucketNamespace,
    leakyBucket: leakyBucketNamespace,
    fixedWindow: fixedWindowNamespace,
  });

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

    const limiterOptions = resolveLimiterConfig
      ? await resolveLimiterConfig(hashedAuthorizationValue, limiter)
      : { type: limiter.type, ...limiter.defaults };

    const rateLimiter = new RateLimiter({
      redis,
      keyPrefix,
      limiter,
      logSuccess: log.requests,
      logFailure: log.rejections,
    });

    const { success, pending, limit, reset, remaining } = await rateLimiter.limit(
      hashedAuthorizationValue
    );

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

export const apiRateLimiter = authorizationRateLimitMiddleware({
  keyPrefix: "api",
  limiter: {
    type: "tokenBucket",
    refillRate: env.API_RATE_LIMIT_REFILL_RATE,
    interval: env.API_RATE_LIMIT_REFILL_INTERVAL as Duration,
    maxTokens: env.API_RATE_LIMIT_MAX,
  },
  resolveLimiterConfig: async (authorizationValue, options) => {},
  pathMatchers: [/^\/api/],
  // Allow /api/v1/tasks/:id/callback/:secret
  pathWhiteList: [
    "/api/internal/stripe_webhooks",
    "/api/v1/authorization-code",
    "/api/v1/token",
    "/api/v1/usage/ingest",
    /^\/api\/v1\/tasks\/[^\/]+\/callback\/[^\/]+$/, // /api/v1/tasks/$id/callback/$secret
    /^\/api\/v1\/runs\/[^\/]+\/tasks\/[^\/]+\/callback\/[^\/]+$/, // /api/v1/runs/$runId/tasks/$id/callback/$secret
    /^\/api\/v1\/http-endpoints\/[^\/]+\/env\/[^\/]+\/[^\/]+$/, // /api/v1/http-endpoints/$httpEndpointId/env/$envType/$shortcode
    /^\/api\/v1\/sources\/http\/[^\/]+$/, // /api/v1/sources/http/$id
    /^\/api\/v1\/endpoints\/[^\/]+\/[^\/]+\/index\/[^\/]+$/, // /api/v1/endpoints/$environmentId/$endpointSlug/index/$indexHookIdentifier
    "/api/v1/timezones",
    "/api/v1/usage/ingest",
    /^\/api\/v1\/runs\/[^\/]+\/attempts$/, // /api/v1/runs/$runFriendlyId/attempts
  ],
  log: {
    rejections: env.API_RATE_LIMIT_REJECTION_LOGS_ENABLED === "1",
    requests: env.API_RATE_LIMIT_REQUEST_LOGS_ENABLED === "1",
  },
});

export type RateLimitMiddleware = ReturnType<typeof authorizationRateLimitMiddleware>;
