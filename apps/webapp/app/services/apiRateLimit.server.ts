import { RedisClientOptions, createClient } from "redis";
import { Ratelimit } from "@upstash/ratelimit";
import {
  ActionFunction,
  ActionFunctionArgs,
  LoaderFunction,
  LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { env } from "~/env.server";

function createRedisRateLimitClient(
  redisOptions: RedisClientOptions
): ConstructorParameters<typeof Ratelimit>[0]["redis"] {
  const redis = createClient(redisOptions);

  return {
    sadd: async <TData>(key: string, ...members: TData[]): Promise<number> => {
      return redis.sAdd(key as string, members as any);
    },
    eval: <TArgs extends unknown[], TData = unknown>(
      ...args: [script: string, keys: string[], args: TArgs]
    ): Promise<TData> => {
      return redis.eval(args[0], {
        keys: args[1],
        arguments: args[2] as string[],
      }) as Promise<TData>;
    },
  };
}

type Options = {
  redis: RedisClientOptions;
  limiter: ConstructorParameters<typeof Ratelimit>[0]["limiter"];
};

class RateLimitter {
  #rateLimitter: Ratelimit;

  constructor({ redis, limiter }: Options) {
    this.#rateLimitter = new Ratelimit({
      redis: createRedisRateLimitClient(redis),
      limiter: limiter,
      ephemeralCache: new Map(),
      analytics: true,
    });
  }

  async loader(key: string, fn: LoaderFunction): Promise<ReturnType<LoaderFunction>> {
    const { success, pending, limit, reset, remaining } = await this.#rateLimitter.limit(
      `ratelimit:${key}`
    );

    if (success) {
      return fn;
    }

    const response = new Response("Rate limit exceeded", { status: 429 });
    response.headers.set("X-RateLimit-Limit", limit.toString());
    response.headers.set("X-RateLimit-Remaining", remaining.toString());
    response.headers.set("X-RateLimit-Reset", reset.toString());
    return response;
  }

  async action(key: string, fn: (args: ActionFunctionArgs) => Promise<ReturnType<ActionFunction>>) {
    const { success, pending, limit, reset, remaining } = await this.#rateLimitter.limit(
      `ratelimit:${key}`
    );

    if (success) {
      return fn;
    }

    const response = new Response("Rate limit exceeded", { status: 429 });
    response.headers.set("X-RateLimit-Limit", limit.toString());
    response.headers.set("X-RateLimit-Remaining", remaining.toString());
    response.headers.set("X-RateLimit-Reset", reset.toString());
    return response;
  }
}

export const standardRateLimitter = new RateLimitter({
  redis: {
    url: `redis://${env.REDIS_USERNAME}:${env.REDIS_PASSWORD}@${env.REDIS_HOST}:${env.REDIS_PORT}`,
  },
  limiter: Ratelimit.slidingWindow(1, "60 s"),
});
