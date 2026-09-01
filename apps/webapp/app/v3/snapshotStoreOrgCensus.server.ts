import { Prisma } from "@trigger.dev/database";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { createReloadingRegistry } from "~/utils/reloadingRegistry.server";
import { singleton } from "~/utils/singleton";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { cachedOrgModeFor, NO_OVERRIDE } from "~/v3/snapshotStoreMode.server";

/** The narrow slice of Prisma the census reads, so a test injects a fake without a mocking library. */
export type SnapshotStoreOrgCensusClient = {
  organization: {
    findMany(args: {
      where: { OR: Array<{ featureFlags: { path: string[]; not: typeof Prisma.DbNull } }> };
      select: { id: true; featureFlags: true };
    }): Promise<Array<{ id: string; featureFlags: unknown }>>;
  };
};

/** Derived from the last successful load. */
type OrgCensusSnapshot = {
  /** Any org at redis-read or redis-only. */
  readEnabled: boolean;
  /** Any org at redis-only. */
  redisOnly: boolean;
  /** Orgs with any non-off override. */
  cohort: Set<string>;
  /** Orgs with the one-way per-org residency latch set true (may be off now, or latch-only). */
  everEnabled: Set<string>;
};

export type SnapshotStoreOrgCensus = {
  anyOrgReadEnabled(): boolean;
  anyOrgRedisOnly(): boolean;
  isCohortMember(organizationId: string): boolean;
  /** DEFINITE never-enabled: census loaded AND the org is not in the ever-enabled set. */
  orgDefinitelyNeverEnabled(organizationId: string): boolean;
  /** Force one load and await it. For tests and boot; the interval drives it in production. */
  refresh(): Promise<void>;
  stop(): void;
};

/** Classifies each org's blob exactly as the per-org resolver does (via cachedOrgModeFor). */
function classify(rows: Array<{ id: string; featureFlags: unknown }>): OrgCensusSnapshot {
  const cohort = new Set<string>();
  const everEnabled = new Set<string>();
  let readEnabled = false;
  let redisOnly = false;
  for (const row of rows) {
    const flags = row.featureFlags as Record<string, unknown> | null | undefined;
    // Strict: only an explicit true latches, matching stampSnapshotStoreOrgEverEnabled.
    if (flags?.[FEATURE_FLAG.snapshotStoreOrgEverEnabled] === true) everEnabled.add(row.id);
    const mode = cachedOrgModeFor(flags?.[FEATURE_FLAG.snapshotStoreOrgMode]);
    if (mode === NO_OVERRIDE || mode === "off") continue;
    cohort.add(row.id);
    if (mode === "redis-read" || mode === "redis-only") readEnabled = true;
    if (mode === "redis-only") redisOnly = true;
  }
  return { readEnabled, redisOnly, cohort, everEnabled };
}

export function createSnapshotStoreOrgCensus(
  clients?: { replica: SnapshotStoreOrgCensusClient },
  opts?: { intervalMs?: number; autoStart?: boolean }
): SnapshotStoreOrgCensus {
  const client = (clients?.replica ?? $replica) as SnapshotStoreOrgCensusClient;
  const registry = createReloadingRegistry<OrgCensusSnapshot>({
    name: "snapshot-store-org-census",
    intervalMs: opts?.intervalMs ?? env.GLOBAL_FLAGS_RELOAD_INTERVAL_MS,
    autoStart: opts?.autoStart ?? process.env.NODE_ENV !== "test",
    load: async () =>
      // WHERE returns orgs with EITHER key, so an ever-enabled org that is now off (or holds only
      // the latch after a clear) still returns. Classification stays in code, identical to the resolver.
      classify(
        await client.organization.findMany({
          where: {
            OR: [
              { featureFlags: { path: [FEATURE_FLAG.snapshotStoreOrgMode], not: Prisma.DbNull } },
              {
                featureFlags: {
                  path: [FEATURE_FLAG.snapshotStoreOrgEverEnabled],
                  not: Prisma.DbNull,
                },
              },
            ],
          },
          select: { id: true, featureFlags: true },
        })
      ),
  });

  return {
    // Cold/failure fail-safe asymmetry. `current()` is undefined only before the first successful
    // load; a later failure keeps the last-good snapshot, so these defaults apply to the cold window
    // alone. The two read accessors err in OPPOSITE directions on purpose:
    //  - anyOrgReadEnabled -> TRUE: a false would suppress per-org read routing and silently break a
    //    soak org's reads. True only makes the decorator resolve the per-org mode, which is correct.
    //  - anyOrgRedisOnly -> FALSE: a true would trigger the conservative over-throw during the cold
    //    window; false lets reads fall back to Postgres, which is authoritative. Err toward fallback.
    //  - isCohortMember -> FALSE: cardinality-safe "other" for the metrics label until loaded.
    anyOrgReadEnabled: () => registry.current()?.readEnabled ?? true,
    anyOrgRedisOnly: () => registry.current()?.redisOnly ?? false,
    isCohortMember: (organizationId) => registry.current()?.cohort.has(organizationId) ?? false,
    // FALSE cold/never-loaded: not-definite means the caller (10c) must NOT skip. Only a loaded
    // census whose ever-enabled set excludes the org yields a definite "never enabled".
    orgDefinitelyNeverEnabled: (organizationId) => {
      const snapshot = registry.current();
      return snapshot ? !snapshot.everEnabled.has(organizationId) : false;
    },
    refresh: async () => {
      // A failed reload keeps the last-good snapshot; swallow so accessors stay safe.
      try {
        await registry.reload();
      } catch {}
    },
    stop: () => registry.stop(),
  };
}

/** Built at import, like globalFlagsRegistry: reads the DB-backed census on GLOBAL_FLAGS_RELOAD_INTERVAL_MS. */
export const snapshotStoreOrgCensus = singleton("snapshotStoreOrgCensus", () =>
  createSnapshotStoreOrgCensus()
);
