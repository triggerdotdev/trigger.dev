import { LRUCache } from "lru-cache";
import type { SnapshotStoreMode, SnapshotStoreModeResolver } from "@internal/run-store";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { FEATURE_FLAG, FeatureFlagCatalog } from "~/v3/featureFlags";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";

/** A cached "this organisation has no override", distinct from "not cached". */
export const NO_OVERRIDE = "__none__" as const;

type CachedOrgMode = SnapshotStoreMode | typeof NO_OVERRIDE;

/**
 * What to cache for one organisation's blob value. An unparseable or absent value caches
 * NO_OVERRIDE rather than nothing: caching nothing means every organisation without an override
 * re-queries on every write, which is all of them until a ramp starts.
 */
export function cachedOrgModeFor(raw: unknown): CachedOrgMode {
  const parsed = FeatureFlagCatalog[FEATURE_FLAG.snapshotStoreOrgMode].safeParse(raw);
  return parsed.success ? parsed.data : NO_OVERRIDE;
}

type OrgModeSource = {
  /** Cache-only: returns undefined on a true miss rather than querying. */
  get(organizationId: string): CachedOrgMode | undefined;
  /** Fire-and-forget, de-duplicated per organisation, never throws. */
  refresh(organizationId: string): void;
};

export function buildSnapshotStoreModeResolver(deps: {
  globalMode: () => SnapshotStoreMode | undefined;
  orgMode: OrgModeSource;
  envFloor: SnapshotStoreMode;
}): SnapshotStoreModeResolver {
  return {
    resolve(organizationId?: string): SnapshotStoreMode {
      const global = deps.globalMode() ?? deps.envFloor;
      if (!organizationId) {
        return global;
      }

      const cached = deps.orgMode.get(organizationId);
      if (cached === NO_OVERRIDE) {
        return global;
      }
      if (cached !== undefined) {
        return cached;
      }

      // Deliberately no read here. Seven decorator methods accept a caller-supplied `tx`, so a
      // query on this path can land inside another caller's open interactive transaction, on the
      // same pool for single-DB and self-host. Serve the global answer, warm the cache off-path.
      try {
        deps.orgMode.refresh(organizationId);
      } catch {
        // a warm-up must never fail a state transition
      }
      return global;
    },
  };
}

function createOrgModeSource(): OrgModeSource {
  const cache = new LRUCache<string, CachedOrgMode>({
    max: env.RUN_ENGINE_SNAPSHOT_STORE_ORG_MODE_CACHE_MAX,
    ttl: env.RUN_ENGINE_SNAPSHOT_STORE_ORG_MODE_CACHE_TTL_MS,
  });
  const inFlight = new Set<string>();

  return {
    get: (organizationId) => cache.get(organizationId),
    refresh: (organizationId) => {
      if (inFlight.has(organizationId)) {
        return;
      }
      inFlight.add(organizationId);

      void $replica.organization
        .findFirst({ where: { id: organizationId }, select: { featureFlags: true } })
        .then((row) => {
          // Only the narrow per-org key. The blob is never passed as `overrides` for the global
          // key, where a parsing override would win outright.
          const raw = (row?.featureFlags as Record<string, unknown> | null | undefined)?.[
            FEATURE_FLAG.snapshotStoreOrgMode
          ];
          cache.set(organizationId, cachedOrgModeFor(raw));
        })
        .catch((error) => {
          logger.warn("snapshotStoreMode: organisation override refresh failed", {
            organizationId,
            error,
          });
        })
        .finally(() => {
          inFlight.delete(organizationId);
        });
    },
  };
}

const orgModeSource = singleton("snapshotStoreOrgModeSource", createOrgModeSource);

export const snapshotStoreModeResolver: SnapshotStoreModeResolver = buildSnapshotStoreModeResolver({
  globalMode: () => globalFlagsRegistry.current()?.[FEATURE_FLAG.snapshotStoreMode],
  orgMode: orgModeSource,
  envFloor: env.RUN_ENGINE_SNAPSHOT_STORE_MODE,
});

/** Called by the organisation flag save path so the writing process sees a dial change at once. */
export function invalidateSnapshotStoreOrgMode(organizationId: string): void {
  orgModeSource.refresh(organizationId);
}
