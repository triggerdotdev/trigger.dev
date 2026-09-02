import type { SnapshotStoreMode, SnapshotStoreModeResolver } from "@internal/run-store";
import { env } from "~/env.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { globalFlagsRegistry } from "~/v3/globalFlagsRegistry.server";
import { snapshotRunOrgSource } from "~/v3/snapshotRunOrg.server";

/** A resolved "this organisation has no override", distinct from a real dial value. */
export const NO_OVERRIDE = "__none__" as const;

/**
 * The dial positions, declared here rather than imported, so this module does not depend on the
 * run-store package's build output to typecheck. The assertion below fails if the two ever diverge.
 */
type DialMode = "off" | "dual-write" | "redis-read" | "redis-only";

/** An organisation can be soaked at any ladder position, including the read positions. */
type OrgDialMode = DialMode;

type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _dialMatchesRunStore: AssertSame<DialMode, SnapshotStoreMode> = true;
void _dialMatchesRunStore;

type CachedOrgMode = OrgDialMode | typeof NO_OVERRIDE;

/** The enrolled-cohort dial map: orgId -> current dial. Undefined models a cold registry. */
type OrgDialMap = Record<string, DialMode>;

/**
 * The polled cohort dial map. The map arrives as a single global-flags key, distributed by
 * `globalFlagsRegistry`, so every read here is pure in-memory: no query, no cache, no TTL. An org
 * absent from the map is never-enrolled; a stored value (including "off", which is never deleted) is
 * that org's current dial.
 */
function orgDials(): OrgDialMap {
  return (globalFlagsRegistry.current()?.[FEATURE_FLAG.snapshotStoreOrgDials] ?? {}) as OrgDialMap;
}

/** True once the registry has loaded at least once. Cold before the first poll completes. */
function orgDialsLoaded(): boolean {
  return globalFlagsRegistry.current() !== undefined;
}

/** The dial map when loaded, or undefined when the registry is still cold. */
function loadedOrgDials(): OrgDialMap | undefined {
  return orgDialsLoaded() ? orgDials() : undefined;
}

// The four aggregate/census accessors, derived purely from the map. Cold is modelled by a `dials`
// argument of undefined, so these are testable without touching the registry. Every derivation reads
// VALUES, never presence alone: a retained "off" entry must not re-enable routing or count as a
// cohort member, but it IS present, so it is not a definite negative either.

/** Any org at a read position. Cold default TRUE, so a cold read never suppresses per-org routing. */
export function snapshotStoreAnyOrgReadEnabled(dials: OrgDialMap | undefined): boolean {
  if (dials === undefined) return true;
  return Object.values(dials).some((m) => m === "redis-read" || m === "redis-only");
}

/** Any org at redis-only. Cold default FALSE, so a cold read falls back to Postgres. */
export function snapshotStoreAnyOrgRedisOnly(dials: OrgDialMap | undefined): boolean {
  if (dials === undefined) return false;
  return Object.values(dials).some((m) => m === "redis-only");
}

/** Cohort membership by VALUE: present and past off. Cold default FALSE (cardinality-safe label). */
export function snapshotStoreIsCohortMember(
  dials: OrgDialMap | undefined,
  organizationId: string
): boolean {
  if (dials === undefined) return false;
  const mode = dials[organizationId];
  return mode !== undefined && mode !== "off";
}

/**
 * DEFINITE never-enabled by ABSENCE: only a loaded map whose keys exclude the org is a definite
 * negative. Cold default FALSE, so an unknown answer keeps the caller probing rather than skipping.
 * A retained "off" entry is present, so it is NOT a definite negative.
 */
export function snapshotStoreOrgDefinitelyNeverEnabled(
  dials: OrgDialMap | undefined,
  organizationId: string
): boolean {
  if (dials === undefined) return false;
  return dials[organizationId] === undefined;
}

/** The map-derived cohort predicate the metrics label uses. Reads the live registry. */
export function isSnapshotStoreCohortMember(organizationId: string): boolean {
  return snapshotStoreIsCohortMember(loadedOrgDials(), organizationId);
}

/** What resolution needs from the org source. Read-only and synchronous; warm is a birth-only hook. */
type ResolverOrgSource = {
  /** The org's dial, or NO_OVERRIDE when absent so `resolveMode` falls back to the global dial. */
  get(organizationId: string): CachedOrgMode | undefined;
  /** No-op with the map source: the dial arrives via the poll, so there is nothing to warm off-path. */
  refresh(organizationId: string): void;
  /** No-op with the map source: births read the map synchronously, so there is nothing to await. */
  warm?(organizationId: string): Promise<void>;
};

/** Resolves a run to its organisation. Cache-only and synchronous, undefined on a miss. */
type ResolverRunOrgSource = {
  resolve(runId: string): string | undefined;
  /** Records an immutable run→org mapping learned off a mirrored write or a Redis read hit. */
  prime?(runId: string, organizationId: string): void;
  /** Bounded authoritative read, throws on failure/timeout, for the redis-only fallback gate. */
  resolveAuthoritative?(runId: string): Promise<string>;
};

/** The census read accessors the resolver delegates to. Both synchronous and no-query. */
type ResolverCensus = {
  anyOrgReadEnabled(): boolean;
  anyOrgRedisOnly(): boolean;
};

export function buildSnapshotStoreModeResolver(deps: {
  globalMode: () => DialMode | undefined;
  /**
   * The one-way global-mode latch, cold-aware: true when the global dial has ever been non-off, and
   * also true when the source is cold, so a cold read never permits a transition skip. Only a loaded
   * source with the latch unset returns false. Absent is treated as true (never skip).
   */
  globalModeEverEnabled?: () => boolean;
  /**
   * Whether an org is DEFINITELY never-enabled, per the map. Absent or cold means false, so an
   * unknown answer keeps probing rather than suppressing a resident run.
   */
  orgDefinitelyNeverEnabled?: (organizationId: string) => boolean;
  orgMode: ResolverOrgSource;
  /** Run→org resolution for the read path. Absent means readModeFor always falls back to global. */
  runOrg?: ResolverRunOrgSource;
  /** The org census for the cheap read gates. Absent means both gates report false. */
  census?: ResolverCensus;
  envFloor: DialMode;
}): SnapshotStoreModeResolver {
  // Shared by resolve and readModeFor: the same org-mode logic, no read on this path.
  const resolveMode = (organizationId?: string): DialMode => {
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
  };

  return {
    // Cold-aware read delegated to deps; absent means true, so a transition never skips on a missing
    // signal. The deps reader answers true while its source is cold.
    globalModeEverEnabled: (): boolean => deps.globalModeEverEnabled?.() ?? true,
    // False ONLY on a definite negative; absent or cold means false, so an unknown answer keeps
    // probing rather than suppressing a resident run.
    orgDefinitelyNeverEnabled: (organizationId: string): boolean =>
      deps.orgDefinitelyNeverEnabled?.(organizationId) ?? false,
    // Awaited at birth sites only. With the map source this resolves immediately: the dial is read
    // synchronously from the polled map, so there is no per-org read to await.
    warm: async (organizationId: string): Promise<void> => {
      await deps.orgMode.warm?.(organizationId);
    },
    resolve: (organizationId?: string): DialMode => resolveMode(organizationId),
    // The org-scoped read position. Resolve run→org synchronously; on a miss return undefined so
    // the decorator falls back to the global mode, which is safe during soak.
    readModeFor: (runId: string): DialMode | undefined => {
      const organizationId = deps.runOrg?.resolve(runId);
      if (!organizationId) {
        return undefined;
      }
      return resolveMode(organizationId);
    },
    // Authoritative counterpart, used only when the sync read is unresolved and some org is
    // redis-only. Resolves run→org from the primary (bounded, throws on failure), then answers with
    // the org's mode straight from the map. A throw propagates so the decorator fails closed.
    readModeForAuthoritative: async (runId: string): Promise<DialMode | undefined> => {
      if (!deps.runOrg?.resolveAuthoritative) {
        return undefined;
      }
      const organizationId = await deps.runOrg.resolveAuthoritative(runId);
      return resolveMode(organizationId);
    },
    anyOrgReadEnabled: (): boolean => deps.census?.anyOrgReadEnabled() ?? false,
    anyOrgRedisOnly: (): boolean => deps.census?.anyOrgRedisOnly() ?? false,
    // The decorator hands back a run→org mapping it learned on a mirrored write or a Redis read hit.
    // Recorded in-memory so a later readModeFor is a pure hit; absent hook is a no-op.
    prime: (runId: string, organizationId: string): void => {
      deps.runOrg?.prime?.(runId, organizationId);
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

export const snapshotStoreModeResolver: SnapshotStoreModeResolver = buildSnapshotStoreModeResolver({
  globalMode: () => globalFlagsRegistry.current()?.[FEATURE_FLAG.snapshotStoreMode],
  globalModeEverEnabled: () => {
    // Conservative cold default: a cold registry must never permit a transition skip, so answer
    // true. Only a loaded registry with the latch unset answers false (skip permitted).
    const cur = globalFlagsRegistry.current();
    if (cur === undefined) return true;
    return cur[FEATURE_FLAG.snapshotStoreGlobalModeEverEnabled] === true;
  },
  orgDefinitelyNeverEnabled: (organizationId) =>
    snapshotStoreOrgDefinitelyNeverEnabled(loadedOrgDials(), organizationId),
  orgMode: {
    // Present value (including "off") wins; absent -> NO_OVERRIDE so resolveMode falls back to the
    // global dial. A cold registry yields an empty map, which reads as NO_OVERRIDE for every org.
    get: (organizationId) => orgDials()[organizationId] ?? NO_OVERRIDE,
    refresh: () => {},
    warm: async () => {},
  },
  runOrg: {
    resolve: (runId) => snapshotRunOrgSource().resolve(runId),
    prime: (runId, organizationId) => snapshotRunOrgSource().prime(runId, organizationId),
    resolveAuthoritative: (runId) => snapshotRunOrgSource().resolveAuthoritative(runId),
  },
  census: {
    anyOrgReadEnabled: () => snapshotStoreAnyOrgReadEnabled(loadedOrgDials()),
    anyOrgRedisOnly: () => snapshotStoreAnyOrgRedisOnly(loadedOrgDials()),
  },
  envFloor: env.RUN_ENGINE_SNAPSHOT_STORE_MODE ?? "off",
});
