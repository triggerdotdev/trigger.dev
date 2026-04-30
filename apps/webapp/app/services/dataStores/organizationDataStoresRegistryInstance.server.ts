import pRetry from "p-retry";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { signalsEmitter } from "~/services/signals.server";
import { singleton } from "~/utils/singleton";
import { OrganizationDataStoresRegistry } from "./organizationDataStoresRegistry.server";

export const organizationDataStoresRegistry = singleton("organizationDataStoresRegistry", () => {
  const registry = new OrganizationDataStoresRegistry($replica);

  // Runs as soon as this singleton is created (first import of this module). The
  // registry’s `isReady` promise resolves when this eventually succeeds.
  const startupLoadPromise = pRetry(() => registry.loadFromDatabase(), {
    forever: true,
    retries: 10,
    minTimeout: 1_000,
    maxTimeout: 60_000,
    factor: 2,
    onFailedAttempt: (error) => {
      logger.warn("[OrganizationDataStoresRegistry] Startup load failed, retrying", {
        attemptNumber: error.attemptNumber,
        retriesLeft: error.retriesLeft,
        error: error.message,
      });
    },
  });
  startupLoadPromise.catch((err) => {
    console.error("[OrganizationDataStoresRegistry] Unexpected startup load failure", err);
  });

  const interval = setInterval(() => {
    registry.reload().catch((err) => {
      console.error("[OrganizationDataStoresRegistry] Failed to reload", err);
    });
  }, env.ORGANIZATION_DATA_STORES_RELOAD_INTERVAL_MS);

  signalsEmitter.on("SIGTERM", () => clearInterval(interval));
  signalsEmitter.on("SIGINT", () => clearInterval(interval));

  return registry;
});
