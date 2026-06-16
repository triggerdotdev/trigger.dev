import { singleton } from "~/utils/singleton";
import { env } from "~/env.server";
import { flags } from "~/v3/featureFlags.server";
import type { FeatureFlagCatalog } from "~/v3/featureFlags";
import { createReloadingRegistry } from "~/utils/reloadingRegistry.server";

/**
 * In-memory snapshot of the global feature flags, refreshed every
 * GLOBAL_FLAGS_RELOAD_INTERVAL_MS. `flags()` reads the DB-backed global values
 * (no per-org overrides). Read synchronously on the trigger hot path; a cold
 * read (before the first load) returns undefined and the resolver falls back to
 * not-migrated.
 */
export const globalFlagsRegistry = singleton("globalFlagsRegistry", () =>
  createReloadingRegistry<Partial<FeatureFlagCatalog>>({
    name: "global-flags",
    intervalMs: env.GLOBAL_FLAGS_RELOAD_INTERVAL_MS,
    autoStart: process.env.NODE_ENV !== "test", // only auto-poll outside tests
    load: () => flags(),
  })
);
