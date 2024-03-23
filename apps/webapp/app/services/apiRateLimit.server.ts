import Redis, { RedisOptions } from "ioredis";
import { Ratelimit } from "@upstash/ratelimit";
import { LoaderFunction, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { env } from "~/env.server";

export function createRedisRateLimitClient(): ConstructorParameters<typeof Ratelimit>[0]["redis"] {
  const redis = new Redis({
    port: env.REDIS_PORT,
    host: env.REDIS_HOST,
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  });

  return {
    sadd: async <TData>(key: string, ...members: TData[]): Promise<number> => {
      return redis.sadd(key, members as (string | Buffer | number)[]);
    },
    eval: <TArgs extends unknown[], TData = unknown>(
      ...args: [script: string, keys: string[], args: TArgs]
    ): Promise<TData> => {
      return redis.eval(...args) as TData;
    },
  };
}

const ratelimitter = new Ratelimit({
  redis: createRedisRateLimitClient(),
  limiter: Ratelimit.cachedFixedWindow(10, "10s"),
  ephemeralCache: new Map(),
  analytics: true,
});

export const rateLimit = {
  loader: (args: LoaderFunctionArgs): ReturnType<LoaderFunction> => {},
};
