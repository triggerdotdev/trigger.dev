import { env } from "~/env.server";
import { createRedisClient } from "~/redis.server";
import { singleton } from "~/utils/singleton";
import {
  createTelemetrySessionStore,
  TELEMETRY_SESSION_REDIS_LIMITS,
  type TelemetrySessionStore,
} from "./telemetrySessionStore";

export function telemetrySessionStore(): TelemetrySessionStore {
  return singleton("mcpTelemetrySessionStore", () =>
    createTelemetrySessionStore(
      createRedisClient("trigger:mcp-telemetry-sessions", {
        host: env.CACHE_REDIS_HOST,
        port: env.CACHE_REDIS_PORT,
        username: env.CACHE_REDIS_USERNAME,
        password: env.CACHE_REDIS_PASSWORD,
        tlsDisabled: env.CACHE_REDIS_TLS_DISABLED === "true",
        clusterMode: env.CACHE_REDIS_CLUSTER_MODE_ENABLED === "1",
        ...TELEMETRY_SESSION_REDIS_LIMITS,
      })
    )
  );
}
