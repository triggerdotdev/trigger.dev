import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { meter } from "./tracer.server";
import { createWaitpointStoreConnection } from "./utils/waitpointStoreConnection.server";

/** Snapshot readers and the engine share one lazy, process-owned MemoryDB connection. */
export const waitpointStoreConnection = singleton("WaitpointStoreConnection", () => {
  const endpoint = env.RUN_ENGINE_WAITPOINT_STORE_REDIS_URL;
  return endpoint
    ? createWaitpointStoreConnection(endpoint, {
        meter,
        onError: (error) => logger.error("Waitpoint connection error", { error }),
      })
    : undefined;
});
