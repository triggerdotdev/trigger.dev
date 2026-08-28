import { LRUCache } from "lru-cache";
import type { SnapshotStoreMode, SnapshotStoreModeResolver } from "@internal/run-store";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { FEATURE_FLAG, FeatureFlagCatalog } from "~/v3/featureFlags";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";

/** A cached "this organisation has no override", distinct from "not cached". */
export const NO_OVERRIDE = "__none__" as const;

/**
 * The dial positions, declared here rather than imported, so this module does not depend on the
 * run-store package's build output to typecheck. The assertion below fails if the two ever diverge.
 */
type DialMode = "off" | "dual-write" | "redis-read" | "redis-only";

/** Only the write positions are settable per organisation: reads are global. */
type OrgDialMode = "off" | "dual-write";

type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _dialMatchesRunStore: AssertSame<DialMode, SnapshotStoreMode> = true;
void _dialMatchesRunStore;

type CachedOrgMode = OrgDialMode | typeof NO_OVERRIDE;

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
  /** Re-reads from the primary after a write, so replica lag cannot re-cache the old value. */
  invalidate(organizationId: string): void;
};

/** What resolution needs. Invalidation is a save-path concern, not a read-path one. */
type ResolverOrgSource = Pick<OrgModeSource, "get" | "refresh">;

export function buildSnapshotStoreModeResolver(deps: {
  globalMode: () => DialMode | undefined;
  orgMode: ResolverOrgSource;
  envFloor: DialMode;
}): SnapshotStoreModeResolver {
  return {
    resolve(organizationId?: string): DialMode {
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

/**
 * The hard stop, and the flag is the whole of it.
 *
 * An environment half used to sit beside this, so a deployment could hold a halt the flag could not
 * lift. It is gone. It converged over a rolling deploy rather than a flag interval, and for the
 * length of that deploy the fleet is mixed: a halted process writes no transition, then an unhalted
 * one asserts a head that was never written and forks. A control whose own convergence manufactures
 * the divergence it exists to stop cannot be the way in. The guaranteed-inert state is an
 * unconfigured host, which is bootstrap config and stays in the environment.
 */
export function buildSnapshotStoreHaltCheck(deps: {
  flag: () => boolean | undefined;
}): () => boolean {
  return () => deps.flag() === true;
}

export const snapshotStoreHalted = buildSnapshotStoreHaltCheck({
  flag: () => globalFlagsRegistry.current()?.[FEATURE_FLAG.snapshotStoreHalt],
});

const DEFAULT_CACHE_MAX = 10_000;
const DEFAULT_CACHE_TTL_MS = 30_000;

type OrgModeClient = {
  organization: {
    findFirst(args: {
      where: { id: string };
      select: { featureFlags: true };
    }): Promise<{ featureFlags: unknown } | null>;
  };
};

export function createOrgModeSource(clients?: {
  primary: OrgModeClient;
  replica: OrgModeClient;
}): OrgModeSource {
  const primaryClient = (clients?.primary ?? prisma) as OrgModeClient;
  const replicaClient = (clients?.replica ?? $replica) as OrgModeClient;
  // Defaults inline as well as in the schema: this must not throw when a caller supplies a partial
  // env, and an LRU with neither bound set is a constructor error.
  const cache = new LRUCache<string, CachedOrgMode>({
    max: env.RUN_ENGINE_SNAPSHOT_STORE_ORG_MODE_CACHE_MAX ?? DEFAULT_CACHE_MAX,
    ttl: env.RUN_ENGINE_SNAPSHOT_STORE_ORG_MODE_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS,
  });
  const inFlight = new Set<string>();
  // Organisations whose primary read is still in flight after a save. A replica refresh started in
  // that window would carry the SAME generation as the invalidation, so the generation guard below
  // could not discard it, and a lagging replica landing second would restore the pre-save value for
  // a full cache TTL. The save is the one read that must win, so nothing else reads during it.
  const primaryPending = new Set<string>();
  // A replica read that started before an invalidation can land after the primary read and put the
  // superseded value back. A per-organisation generation lets a stale load discard its own result.
  const generations = new Map<string, number>();
  const generationOf = (organizationId: string) => generations.get(organizationId) ?? 0;

  return {
    get: (organizationId) => cache.get(organizationId),
    invalidate: (organizationId) => {
      // Drop first, so a resolve between now and the re-read falls back rather than serving a
      // value the write just replaced.
      const generation = generationOf(organizationId) + 1;
      generations.set(organizationId, generation);
      cache.delete(organizationId);
      primaryPending.add(organizationId);
      void load(organizationId, primaryClient, generation).finally(() => {
        primaryPending.delete(organizationId);
      });
    },
    refresh: (organizationId) => {
      // A save is mid-read for this organisation. Its answer is authoritative and a replica cannot
      // improve on it, so skip: the resolver falls back to the global position until it lands.
      if (primaryPending.has(organizationId) || inFlight.has(organizationId)) {
        return;
      }
      inFlight.add(organizationId);

      void load(organizationId, replicaClient, generationOf(organizationId)).finally(() => {
        inFlight.delete(organizationId);
      });
    },
  };

  function load(organizationId: string, client: OrgModeClient, generation: number) {
    return client.organization
      .findFirst({ where: { id: organizationId }, select: { featureFlags: true } })
      .then((row) => {
        // Only the narrow per-org key. The blob is never passed as `overrides` for the global
        // key, where a parsing override would win outright.
        const raw = (row?.featureFlags as Record<string, unknown> | null | undefined)?.[
          FEATURE_FLAG.snapshotStoreOrgMode
        ];
        // A newer invalidation happened while this read was in flight, so its answer is stale.
        if (generation < generationOf(organizationId)) {
          return;
        }
        cache.set(organizationId, cachedOrgModeFor(raw));
      })
      .catch((error) => {
        logger.warn("snapshotStoreMode: organisation override read failed", {
          organizationId,
          error,
        });
      });
  }
}

/** Built on first use, never at import: importing this module must have no side effect. */
function orgModeSource(): OrgModeSource {
  return singleton("snapshotStoreOrgModeSource", createOrgModeSource);
}

export const snapshotStoreModeResolver: SnapshotStoreModeResolver = buildSnapshotStoreModeResolver({
  globalMode: () => globalFlagsRegistry.current()?.[FEATURE_FLAG.snapshotStoreMode],
  orgMode: {
    get: (organizationId) => orgModeSource().get(organizationId),
    refresh: (organizationId) => orgModeSource().refresh(organizationId),
  },
  envFloor: env.RUN_ENGINE_SNAPSHOT_STORE_MODE ?? "off",
});

/** Called by the organisation flag save path so the writing process sees a dial change at once. */
export function invalidateSnapshotStoreOrgMode(organizationId: string): void {
  orgModeSource().invalidate(organizationId);
}
