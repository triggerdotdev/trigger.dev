import { ActionFunction, ActionFunctionArgs, LoaderFunction } from "@remix-run/server-runtime";
import { Ratelimit } from "@upstash/ratelimit";
import Redis, { RedisOptions } from "ioredis";
import { env } from "~/env.server";

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
  redis: RedisOptions;
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

  //todo Express middleware
  //use the Authentication header with Bearer token

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
    port: env.REDIS_PORT,
    host: env.REDIS_HOST,
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  },
  limiter: Ratelimit.slidingWindow(1, "60 s"),
});
