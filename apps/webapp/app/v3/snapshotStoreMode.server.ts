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
  /**
   * Awaits the organisation's value on a cache miss, bounded, and never throws. Used at BIRTH sites
   * only: residency is permanent, so a run born during a miss is excluded from the mirror for life.
   */
  warm(organizationId: string): Promise<void>;
};

/** What resolution needs. Invalidation is a save-path concern, not a read-path one. */
type ResolverOrgSource = Pick<OrgModeSource, "get" | "refresh"> &
  Partial<Pick<OrgModeSource, "warm">>;

export function buildSnapshotStoreModeResolver(deps: {
  globalMode: () => DialMode | undefined;
  orgMode: ResolverOrgSource;
  envFloor: DialMode;
}): SnapshotStoreModeResolver {
  return {
    // Awaited at birth sites only. Absent org id means nothing to look up, so it is a no-op.
    warm: async (organizationId: string): Promise<void> => {
      await deps.orgMode.warm?.(organizationId);
    },
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

/**
 * How long a birth will wait for its organisation's dial before proceeding without it. Short because
 * the read is a single primary-key select, and because the cost of overrunning is a caller's
 * transaction held open.
 */
const WARM_TIMEOUT_MS = 500;

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
  // Organisations whose primary read is still in flight after a save, keyed to the GENERATION that
  // owns the read. A replica refresh started in that window would carry the SAME generation as the
  // invalidation, so the generation guard below could not discard it, and a lagging replica landing
  // second would restore the pre-save value for a full cache TTL. The save is the one read that must
  // win, so nothing else reads during it.
  //
  // A Set was not enough. Two overlapping saves for one organisation share one entry, so the FIRST
  // read's completion cleared it while the second was still outstanding, and the window reopened
  // exactly when a second save made it most dangerous. Holding the generation means a completing
  // read only clears the flag when it still owns it.
  const primaryPending = new Map<string, number>();
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
      primaryPending.set(organizationId, generation);
      void load(organizationId, primaryClient, generation).then((outcome) => {
        // Only if no NEWER save has claimed it since. Deleting unconditionally is what let an older
        // read reopen the window for a newer one.
        if (primaryPending.get(organizationId) !== generation) {
          return;
        }
        // And only if the primary actually ANSWERED. `load` swallows its own errors, so a rejected
        // primary read used to clear the flag with nothing cached, reopening the window to a lagging
        // replica that would then restore the pre-save value for a full cache lifetime. Staying
        // pending keeps replica refreshes out until a primary read succeeds; the resolver falls back
        // to the deployment-wide position meanwhile, which is the safe answer.
        if (outcome === "failed") {
          return;
        }
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
    warm: async (organizationId) => {
      // Already known, including a cached "no override". Costs nothing, which is the common case
      // once an organisation has any traffic at all.
      if (cache.get(organizationId) !== undefined) {
        return;
      }

      // A save is mid-read: its answer is the authoritative one and is already on its way, so wait
      // for that rather than starting a second read of the same row.
      const pending = primaryPending.has(organizationId)
        ? undefined
        : load(organizationId, replicaClient, generationOf(organizationId));

      // Bounded on purpose. A birth is on the trigger path and the caller may already hold an open
      // transaction, so a slow flag read must give up rather than hold that transaction open. Giving
      // up restores the previous behaviour (answer with the deployment-wide position) rather than
      // failing the trigger.
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, WARM_TIMEOUT_MS);
      });

      try {
        await Promise.race([pending ?? deadline, deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };

  function load(
    organizationId: string,
    client: OrgModeClient,
    generation: number
  ): Promise<"loaded" | "stale" | "failed"> {
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
          return "stale" as const;
        }
        cache.set(organizationId, cachedOrgModeFor(raw));
        return "loaded" as const;
      })
      .catch((error) => {
        logger.warn("snapshotStoreMode: organisation override read failed", {
          organizationId,
          error,
        });
        return "failed" as const;
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
    warm: (organizationId) => orgModeSource().warm(organizationId),
  },
  envFloor: env.RUN_ENGINE_SNAPSHOT_STORE_MODE ?? "off",
});

/** Called by the organisation flag save path so the writing process sees a dial change at once. */
export function invalidateSnapshotStoreOrgMode(organizationId: string): void {
  orgModeSource().invalidate(organizationId);
}
