import { Ratelimit } from "@upstash/ratelimit";
import { RedisOptions } from "ioredis";
import { env } from "~/env.server";
import { createRedisClient, RedisWithClusterOptions } from "~/redis.server";
import { logger } from "./logger.server";

type Options = {
  redis?: RedisOptions;
  redisClient?: RateLimiterRedisClient;
  keyPrefix: string;
  limiter: Limiter;
  logSuccess?: boolean;
  logFailure?: boolean;
};

export type Limiter = ConstructorParameters<typeof Ratelimit>[0]["limiter"];
export type Duration = Parameters<typeof Ratelimit.slidingWindow>[1];
export type RateLimitResponse = Awaited<ReturnType<Ratelimit["limit"]>>;
export type RateLimiterRedisClient = ConstructorParameters<typeof Ratelimit>[0]["redis"];

export class RateLimiter {
  #ratelimit: Ratelimit;

  constructor(private readonly options: Options) {
    const { redis, redisClient, keyPrefix, limiter } = options;
    const prefix = `ratelimit:${keyPrefix}`;
    this.#ratelimit = new Ratelimit({
      redis:
        redisClient ??
        createRedisRateLimitClient(
          redis ?? {
            port: env.RATE_LIMIT_REDIS_PORT,
            host: env.RATE_LIMIT_REDIS_HOST,
            username: env.RATE_LIMIT_REDIS_USERNAME,
            password: env.RATE_LIMIT_REDIS_PASSWORD,
            tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
            clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
          }
        ),
      limiter,
      ephemeralCache: new Map(),
      analytics: false,
      prefix,
    });
  }

  async limit(identifier: string, rate = 1): Promise<RateLimitResponse> {
    const result = this.#ratelimit.limit(identifier, { rate });
    const { success, limit, reset, remaining } = await result;

    if (success && this.options.logSuccess) {
      logger.info(`RateLimiter (${this.options.keyPrefix}): under rate limit`, {
        limit,
        reset,
        remaining,
        identifier,
      });
    }

    //log these by default
    if (!success && this.options.logFailure !== false) {
      logger.info(`RateLimiter (${this.options.keyPrefix}): rate limit exceeded`, {
        limit,
        reset,
        remaining,
        identifier,
      });
    }

    return result;
  }
}

export function createRedisRateLimitClient(
  redisOptions: RedisWithClusterOptions
): RateLimiterRedisClient {
  const redis = createRedisClient("trigger:rateLimiter", redisOptions);

  return {
    sadd: async <TData>(key: string, ...members: TData[]): Promise<number> => {
      return redis.sadd(key, members as (string | number | Buffer)[]);
    },
    hset: <TValue>(
      key: string,
      obj: {
        [key: string]: TValue;
      }
    ): Promise<number> => {
      return redis.hset(key, obj);
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
