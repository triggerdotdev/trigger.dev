import { Redis } from "ioredis";
import { defaultReconnectOnError } from "@internal/redis";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import {
  NoopTaskMetadataCache,
  RedisTaskMetadataCache,
  type TaskMetadataCache,
} from "./taskMetadataCache.server";

export const taskMetadataCacheInstance: TaskMetadataCache = singleton(
  "taskMetadataCacheInstance",
  initializeTaskMetadataCache
);

function initializeTaskMetadataCache(): TaskMetadataCache {
  if (!env.TASK_META_CACHE_REDIS_HOST) {
    return new NoopTaskMetadataCache();
  }

  const redis = new Redis({
    connectionName: "taskMetadataCache",
    host: env.TASK_META_CACHE_REDIS_HOST,
    port: env.TASK_META_CACHE_REDIS_PORT,
    username: env.TASK_META_CACHE_REDIS_USERNAME,
    password: env.TASK_META_CACHE_REDIS_PASSWORD,
    keyPrefix: "tr:",
    enableAutoPipelining: true,
    reconnectOnError: defaultReconnectOnError,
    ...(env.TASK_META_CACHE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  });

  return new RedisTaskMetadataCache({
    redis,
    currentEnvTtlSeconds: env.TASK_META_CACHE_CURRENT_ENV_TTL_SECONDS,
    byWorkerTtlSeconds: env.TASK_META_CACHE_BY_WORKER_TTL_SECONDS,
  });
}
