import { Ratelimit } from "@upstash/ratelimit";
import { Request as ExpressRequest, Response as ExpressResponse, NextFunction } from "express";
import Redis, { RedisOptions } from "ioredis";
import { createHash } from "node:crypto";
import { env } from "~/env.server";
import { logger } from "./logger.server";

function createRedisRateLimitClient(
  redisOptions: RedisOptions
): ConstructorParameters<typeof Ratelimit>[0]["redis"] {
  const redis = new Redis(redisOptions);

  return {
    sadd: async <TData>(key: string, ...members: TData[]): Promise<number> => {
      return redis.sadd(key, members as (string | number | Buffer)[]);
    },
    eval: <TArgs extends unknown[], TData = unknown>(
      ...args: [script: string, keys: string[], args: TArgs]
    ): Promise<TData> => {
      const script = args[0];
      const keys = args[1];
      const argsArray = args[2];
      return redis.eval(
        script,
        keys.length,
        ...keys,
        ...(argsArray as (string | Buffer | number)[])
      ) as Promise<TData>;
    },
  };
}

type Options = {
  log?: {
    requests?: boolean;
    rejections?: boolean;
  };
  redis: RedisOptions;
  keyPrefix: string;
  pathMatchers: (RegExp | string)[];
  pathWhiteList?: (RegExp | string)[];
  limiter: ConstructorParameters<typeof Ratelimit>[0]["limiter"];
};

//returns an Express middleware that rate limits using the Bearer token in the Authorization header
export function authorizationRateLimitMiddleware({
  redis,
  keyPrefix,
  limiter,
  pathMatchers,
  pathWhiteList = [],
  log = {
    rejections: true,
    requests: true,
  },
}: Options) {
  const rateLimiter = new Ratelimit({
    redis: createRedisRateLimitClient(redis),
    limiter: limiter,
    ephemeralCache: new Map(),
    analytics: false,
    prefix: keyPrefix,
  });

  return async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    if (log.requests) {
      logger.info(`RateLimiter (${keyPrefix}): request to ${req.path}`);
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
        logger.info(`RateLimiter (${keyPrefix}): no key`);
      }
      res.setHeader("Content-Type", "application/problem+json");
      return res.status(401).send(
        JSON.stringify(
          {
            title: "Unauthorized",
            status: 401,
            type: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/401",
            detail: "No authorization header provided",
          },
          null,
          2
        )
      );
    }

    const hash = createHash("sha256");
    hash.update(authorizationValue);
    const hashedAuthorizationValue = hash.digest("hex");

    const { success, pending, limit, reset, remaining } = await rateLimiter.limit(
      hashedAuthorizationValue
    );

    res.set("x-ratelimit-limit", limit.toString());
    res.set("x-ratelimit-remaining", remaining.toString());
    res.set("x-ratelimit-reset", reset.toString());

    if (success) {
      if (log.requests) {
        logger.info(`RateLimiter (${keyPrefix}): under rate limit`, {
          limit,
          reset,
          remaining,
          hashedAuthorizationValue,
        });
      }
      return next();
    }

    if (log.rejections) {
      logger.warn(`RateLimiter (${keyPrefix}): rate limit exceeded`, {
        limit,
        reset,
        remaining,
        pending,
        hashedAuthorizationValue,
      });
    }

    res.setHeader("Content-Type", "application/problem+json");
    return res.status(429).send(
      JSON.stringify(
        {
          title: "Rate Limit Exceeded",
          status: 429,
          type: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/429",
          detail: `Rate limit exceeded ${remaining}/${limit} requests remaining. Retry after ${reset} seconds.`,
          reset: reset,
          limit: limit,
        },
        null,
        2
      )
    );
  };
}

type Duration = Parameters<typeof Ratelimit.slidingWindow>[1];

export const apiRateLimiter = authorizationRateLimitMiddleware({
  keyPrefix: "ratelimit:api",
  redis: {
    port: env.REDIS_PORT,
    host: env.REDIS_HOST,
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  },
  limiter: Ratelimit.slidingWindow(env.API_RATE_LIMIT_MAX, env.API_RATE_LIMIT_WINDOW as Duration),
  pathMatchers: [/^\/api/],
  pathWhiteList: ["/api/v1/authorization-code", "/api/v1/token"],
  log: {
    rejections: env.API_RATE_LIMIT_REJECTION_LOGS_ENABLED === "1",
    requests: env.API_RATE_LIMIT_REQUEST_LOGS_ENABLED === "1",
  },
});

export type RateLimitMiddleware = ReturnType<typeof authorizationRateLimitMiddleware>;
