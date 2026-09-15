import { defaultReconnectOnError } from "@internal/redis";
import Redis from "ioredis";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import {
  type ExternalDeploymentCache,
  NoopExternalDeploymentCache,
  RedisExternalDeploymentCache,
} from "./externalDeploymentCache.server";

export const externalDeploymentCacheInstance: ExternalDeploymentCache = singleton(
  "externalDeploymentCacheInstance",
  initializeExternalDeploymentCache
);

function initializeExternalDeploymentCache(): ExternalDeploymentCache {
  if (!env.EXTERNAL_DEPLOYMENT_CACHE_REDIS_HOST) {
    return new NoopExternalDeploymentCache();
  }

  const redis = new Redis({
    connectionName: "externalDeploymentCache",
    host: env.EXTERNAL_DEPLOYMENT_CACHE_REDIS_HOST,
    port: env.EXTERNAL_DEPLOYMENT_CACHE_REDIS_PORT,
    username: env.EXTERNAL_DEPLOYMENT_CACHE_REDIS_USERNAME,
    password: env.EXTERNAL_DEPLOYMENT_CACHE_REDIS_PASSWORD,
    keyPrefix: "tr:",
    enableAutoPipelining: true,
    reconnectOnError: defaultReconnectOnError,
    ...(env.EXTERNAL_DEPLOYMENT_CACHE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  });

  return new RedisExternalDeploymentCache({
    redis,
    ttlSeconds: env.EXTERNAL_DEPLOYMENT_CACHE_TTL_SECONDS,
    missingTtlSeconds: env.EXTERNAL_DEPLOYMENT_CACHE_MISSING_TTL_SECONDS,
  });
}
