import { Ratelimit } from "@upstash/ratelimit";
import Redis, { type RedisOptions } from "ioredis";
import { env } from "~/env.server";
import { logger } from "./logger.server";

type Options = {
  redis?: RedisOptions;
  keyPrefix: string;
  limiter: Limiter;
  logSuccess?: boolean;
  logFailure?: boolean;
};

export type Limiter = ConstructorParameters<typeof Ratelimit>[0]["limiter"];
export type Duration = Parameters<typeof Ratelimit.slidingWindow>[1];
export type RateLimitResponse = Awaited<ReturnType<Ratelimit["limit"]>>;

export class RateLimiter {
  #ratelimit: Ratelimit;

  constructor(private readonly options: Options) {
    const { redis, keyPrefix, limiter } = options;
    const prefix = `ratelimit:${keyPrefix}`;
    this.#ratelimit = new Ratelimit({
      redis: createRedisRateLimitClient(
        redis ?? {
          port: env.REDIS_PORT,
          host: env.REDIS_HOST,
          username: env.REDIS_USERNAME,
          password: env.REDIS_PASSWORD,
          enableAutoPipelining: true,
          ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
        }
      ),
      limiter,
      ephemeralCache: new Map(),
      analytics: false,
      prefix,
    });

    logger.info(`RateLimiter (${keyPrefix}): initialized`, {
      keyPrefix,
      redisKeyspace: prefix,
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
  redisOptions: RedisOptions
): ConstructorParameters<typeof Ratelimit>[0]["redis"] {
  const redis = new Redis(redisOptions);

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
