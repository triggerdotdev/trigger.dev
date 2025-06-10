import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { RealtimeClient } from "./realtimeClient.server";
import { getCachedLimit } from "./platform.v3.server";

function initializeRealtimeClient() {
  const electricOrigin = env.ELECTRIC_ORIGIN_SHARDS?.split(",") ?? env.ELECTRIC_ORIGIN;

  return new RealtimeClient({
    electricOrigin: electricOrigin,
    keyPrefix: "tr:realtime:concurrency",
    redis: {
      port: env.RATE_LIMIT_REDIS_PORT,
      host: env.RATE_LIMIT_REDIS_HOST,
      username: env.RATE_LIMIT_REDIS_USERNAME,
      password: env.RATE_LIMIT_REDIS_PASSWORD,
      tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
      clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
    },
    cachedLimitProvider: {
      async getCachedLimit(organizationId, defaultValue) {
        const result = await getCachedLimit(
          organizationId,
          "realtimeConcurrentConnections",
          defaultValue
        );

        return result.val;
      },
    },
  });
}

export const realtimeClient = singleton("realtimeClient", initializeRealtimeClient);
