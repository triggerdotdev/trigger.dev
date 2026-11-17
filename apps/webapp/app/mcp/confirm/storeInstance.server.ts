import { env } from "~/env.server";
import { createRedisClient } from "~/redis.server";
import { singleton } from "~/utils/singleton";
import { createMcpConfirmationStore, type McpConfirmationStore } from "./store.server";

export const mcpConfirmationErrorMode = env.MCP_CONFIRMATION_ERROR_MODE;

export function getMcpConfirmationStore(): McpConfirmationStore {
  return singleton("mcpConfirmationStore", () =>
    createMcpConfirmationStore(
      createRedisClient("trigger:mcp-confirmations", {
        host: env.CACHE_REDIS_HOST,
        port: env.CACHE_REDIS_PORT,
        username: env.CACHE_REDIS_USERNAME,
        password: env.CACHE_REDIS_PASSWORD,
        tlsDisabled: env.CACHE_REDIS_TLS_DISABLED === "true",
        clusterMode: env.CACHE_REDIS_CLUSTER_MODE_ENABLED === "1",
      }),
      { origin: env.APP_ORIGIN }
    )
  );
}
