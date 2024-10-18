import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { RealtimeClient } from "./realtimeClient.server";
import { getCachedLimit } from "./platform.v3.server";

function initializeRealtimeClient() {
  return new RealtimeClient({
    electricOrigin: env.ELECTRIC_ORIGIN,
    keyPrefix: "tr:realtime:concurrency",
    redis: {
      port: env.REDIS_PORT,
      host: env.REDIS_HOST,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
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
