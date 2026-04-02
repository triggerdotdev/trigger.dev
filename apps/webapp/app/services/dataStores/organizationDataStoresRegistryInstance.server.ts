import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { signalsEmitter } from "~/services/signals.server";
import { singleton } from "~/utils/singleton";
import { OrganizationDataStoresRegistry } from "./organizationDataStoresRegistry.server";

export const organizationDataStoresRegistry = singleton("organizationDataStoresRegistry", () => {
  const registry = new OrganizationDataStoresRegistry($replica);

  registry.loadFromDatabase().catch((err) => {
    console.error("[OrganizationDataStoresRegistry] Failed to initialize", err);
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
