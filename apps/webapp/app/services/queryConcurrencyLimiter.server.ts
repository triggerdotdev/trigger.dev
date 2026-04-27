import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { RedisConcurrencyLimiter } from "./redisConcurrencyLimiter.server";

function initializeQueryConcurrencyLimiter() {
  return new RedisConcurrencyLimiter({
    keyPrefix: "query:concurrency",
    redis: {
      port: env.RATE_LIMIT_REDIS_PORT,
      host: env.RATE_LIMIT_REDIS_HOST,
      username: env.RATE_LIMIT_REDIS_USERNAME,
      password: env.RATE_LIMIT_REDIS_PASSWORD,
      tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
      clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
    },
  });
}

export const queryConcurrencyLimiter = singleton(
  "queryConcurrencyLimiter",
  initializeQueryConcurrencyLimiter
);

/** Default per-org concurrency limit from environment */
export const DEFAULT_ORG_CONCURRENCY_LIMIT = env.QUERY_DEFAULT_ORG_CONCURRENCY_LIMIT;

/** Global concurrency limit from environment */
export const GLOBAL_CONCURRENCY_LIMIT = env.QUERY_GLOBAL_CONCURRENCY_LIMIT;

