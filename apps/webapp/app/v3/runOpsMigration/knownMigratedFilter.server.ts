/**
 * Known-migrated filter.
 *
 * "Known migrated" is true when a run's row has been copied to the NEW run-ops DB
 * and the OLD side has been fenced. The read-through layer consults this predicate
 * to AVOID re-probing the legacy read replica for runs that already live on new —
 * that re-probe is exactly the read load we are shedding off the legacy DB's replica.
 *
 * Authority order:
 *   1. Cache hit → return it.
 *   2. Redirect-marker on the OLD side (`readMarker(runId)` true) → migrated.
 *      The marker is the authoritative "this row now lives on the new DB" signal
 *      written by the live-migration fencing primitive.
 *   3. Fall back to a NEW-DB existence probe (`probeNew(runId)`) — covers
 *      backfilled/straggler-swept rows whose marker is gone (GC'd) or whose mere
 *      presence on new is the only remaining evidence.
 *
 * Caching policy: positives are cached aggressively (a migrated row never
 * un-migrates within the retention window); negatives are NOT cached (a
 * not-yet-migrated row may migrate at any moment, and re-reading legacy for it is
 * still correct — the row is there until termination — so the only cost of a stale
 * negative would be a brief extra probe, which we avoid by simply not caching it).
 */
import { BoundedTtlCache } from "~/services/realtime/boundedTtlCache";
import { isFenced, type RedirectMarkerClient } from "@internal/run-engine";

type KnownMigratedDeps = {
  /** Authoritative migrated-marker source: true iff the OLD side is fenced for this run. */
  readMarker?: (runId: string) => Promise<boolean>;
  /** Fallback NEW-DB existence probe: true iff the run already exists on the new store. */
  probeNew?: (runId: string) => Promise<boolean>;
  /** Bounded TTL memo for positive results. */
  cache?: BoundedTtlCache<boolean>;
  /** TTL (ms) used by the default module-level cache. */
  ttlMs?: number;
  /** OLD/LEGACY run-ops client the default `readMarker` reads the fence from. */
  legacyMarkerClient?: RedirectMarkerClient;
};

/** Default positive-cache TTL: long, because a migrated row never un-migrates in the window. */
const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 50_000;

/**
 * PURE testable core (no `env`/`db.server`/`process.env` import — webapp testability rule).
 * Tests inject `readMarker`/`probeNew` as pure boundaries (NOT DB mocks).
 */
export async function computeKnownMigrated(
  runId: string,
  deps: KnownMigratedDeps
): Promise<boolean> {
  const cache = deps.cache;

  // We only ever store positives, so a hit is always `true`.
  const cached = cache?.get(runId);
  if (cached !== undefined) {
    return cached;
  }

  // Marker present → migrated, never probe new.
  if (deps.readMarker && (await deps.readMarker(runId))) {
    cache?.set(runId, true);
    return true;
  }

  if (deps.probeNew && (await deps.probeNew(runId))) {
    cache?.set(runId, true);
    return true;
  }

  // Not migrated. Negatives are not cached (see policy note above).
  return false;
}

let defaultCache: BoundedTtlCache<boolean> | undefined;

function getDefaultCache(ttlMs: number): BoundedTtlCache<boolean> {
  if (!defaultCache) {
    defaultCache = new BoundedTtlCache<boolean>(ttlMs, DEFAULT_MAX_ENTRIES);
  }
  return defaultCache;
}

/**
 * Default `readMarker` adapter. Delegates to the OLD-side fence (`isFenced`) so the
 * redirect marker is the migrated authority. The legacy run-ops replica
 * client is injected by the wired wrapper (`isKnownMigrated`) — the pure core never
 * imports `db.server`.
 */
function makeDefaultReadMarker(
  client: RedirectMarkerClient
): (runId: string) => Promise<boolean> {
  return (runId: string) => isFenced(client, runId);
}

/**
 * Wired wrapper. Defaults `readMarker` to the marker adapter above, `probeNew` to a
 * NEW run-ops existence check, and `cache` to a module-level singleton.
 *
 * The `probeNew` default uses `findFirst` (NEVER `findUnique` — webapp Prisma rule)
 * against the new run-ops writer handle.
 */
export async function isKnownMigrated(runId: string, deps?: KnownMigratedDeps): Promise<boolean> {
  const ttlMs = deps?.ttlMs ?? DEFAULT_TTL_MS;

  // Lazy default for probeNew so the db.server import stays out of the pure core and
  // only resolves when the wired wrapper actually needs it.
  const probeNew =
    deps?.probeNew ??
    (async (id: string) => {
      const { runOpsNewPrisma } = await import("~/db.server");
      const row = await runOpsNewPrisma.taskRun.findFirst({
        where: { friendlyId: id },
        select: { friendlyId: true },
      });
      return row !== null;
    });

  // Resolve the OLD/LEGACY marker client (injected for tests; the legacy run-ops
  // replica in production). Only needed when no explicit readMarker is provided.
  let readMarker = deps?.readMarker;
  if (!readMarker) {
    const legacyMarkerClient =
      deps?.legacyMarkerClient ?? (await import("~/db.server")).runOpsLegacyReplica;
    readMarker = makeDefaultReadMarker(legacyMarkerClient);
  }

  return computeKnownMigrated(runId, {
    readMarker,
    probeNew,
    cache: deps?.cache ?? getDefaultCache(ttlMs),
    ttlMs,
  });
}

export function __resetKnownMigratedCacheForTests(): void {
  defaultCache = undefined;
}
