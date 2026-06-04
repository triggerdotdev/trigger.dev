import { organizationDataStoresRegistry } from "~/services/dataStores/organizationDataStoresRegistryInstance.server";
import { singleton } from "~/utils/singleton";
import { ClickhouseFactory } from "./clickhouseFactory.server";

/**
 * Production singleton wired to the global organization data-stores registry.
 * Import this only from app/runtime code — not from tests that construct a
 * {@link ClickhouseFactory} with a stub registry (see `clickhouseFactory.server.ts`).
 */
export const clickhouseFactory = singleton(
  "clickhouseFactory",
  () => new ClickhouseFactory(organizationDataStoresRegistry)
);
