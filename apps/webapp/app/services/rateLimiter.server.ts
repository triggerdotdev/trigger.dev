import { env } from "~/env.server";
import type { RedisWithClusterOptions } from "~/redis.server";
import {
  RateLimiter as CoreRateLimiter,
  type Limiter,
  type RateLimiterRedisClient,
} from "./rateLimiterCore.server";

export {
  createRedisRateLimitClient,
  type Duration,
  type Limiter,
  type RateLimitResponse,
  type RateLimiterRedisClient,
} from "./rateLimiterCore.server";

type Options = {
  redis?: RedisWithClusterOptions;
  redisClient?: RateLimiterRedisClient;
  keyPrefix: string;
  limiter: Limiter;
  logSuccess?: boolean;
  logFailure?: boolean;
};

export class RateLimiter extends CoreRateLimiter {
  constructor(options: Options) {
    super({
      ...options,
      redis: options.redis ?? {
        port: env.RATE_LIMIT_REDIS_PORT,
        host: env.RATE_LIMIT_REDIS_HOST,
        username: env.RATE_LIMIT_REDIS_USERNAME,
        password: env.RATE_LIMIT_REDIS_PASSWORD,
        tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
        clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
      },
    });
  }
}
