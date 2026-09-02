import { PrismaClient } from "@trigger.dev/database";

type DatabaseFingerprint = { systemIdentifier: string; databaseName: string };

async function readDatabaseFingerprint(url: string): Promise<DatabaseFingerprint> {
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    const rows = await client.$queryRawUnsafe<
      Array<{ system_identifier: string; database_name: string }>
    >(
      "SELECT system_identifier::text AS system_identifier, current_database() AS database_name FROM pg_control_system()"
    );
    const row = rows[0];
    if (!row) {
      throw new Error("distinct-db sentinel: pg_control_system() returned no rows");
    }
    return { systemIdentifier: row.system_identifier, databaseName: row.database_name };
  } finally {
    await client.$disconnect();
  }
}

// Advisory co-residency verdict (Track 2, T2.3): "true" = legacy and control-plane are the SAME
// physical DB (expected during the same-DSN stage); "false" = distinct DBs (cutover confirmation);
// "unknown" = the fingerprint probe was denied/failed. A failed probe is ALWAYS "unknown", never
// "false" — "false" is a positive "confirmed split" claim a failed probe cannot support.
export type CoresidencyVerdict = "true" | "false" | "unknown";
export type CoresidencyProbeResult =
  | { coresident: "true"; reason: string }
  | { coresident: "false" }
  | { coresident: "unknown"; reason: string };

// Probe whether the legacy run-ops DB is co-resident with the control-plane DB, reusing the same
// systemIdentifier + current_database() fingerprint as the distinct-DB sentinel. Never throws.
export async function probeControlPlaneCoresidency(
  legacyUrl: string,
  controlPlaneUrl: string,
  opts?: { logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void } }
): Promise<CoresidencyProbeResult> {
  try {
    const [legacy, controlPlane] = await Promise.all([
      readDatabaseFingerprint(legacyUrl),
      readDatabaseFingerprint(controlPlaneUrl),
    ]);
    const sameDb =
      legacy.systemIdentifier === controlPlane.systemIdentifier &&
      legacy.databaseName === controlPlane.databaseName;
    if (sameDb) {
      return {
        coresident: "true",
        reason:
          "legacy run-ops and control-plane resolve to the SAME physical database " +
          `(systemIdentifier=${legacy.systemIdentifier}, database=${legacy.databaseName})`,
      };
    }
    return { coresident: "false" };
  } catch (error) {
    // Managed PG may restrict pg_control_system(): we cannot confirm co-residency -> "unknown".
    const reason = `control-plane co-residency probe failed; reporting unknown. ${String(error)}`;
    opts?.logger?.warn(reason, { error });
    return { coresident: "unknown", reason };
  }
}

export type DistinctTarget = { id: string; url: string };

/** Injection seam for the retry tests: no containers, no real waiting. */
export type DistinctProbeOptions = {
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  readFingerprint?: (url: string) => Promise<DatabaseFingerprint>;
  /** Total attempts per target, including the first. Bounded so boot latency stays bounded. */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_PROBE_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read one fingerprint, retrying a bounded number of times.
 *
 * The probe fails CLOSED, and that must not change: "distinct" is a positive claim a failed probe
 * cannot support. But failing closed on the first blip means one shard being briefly unreachable
 * collapses the deployment to single-DB, and the boot interlock then refuses the boot for the whole
 * fleet. A transient error deserves a retry; a persistent one still fails closed, just later.
 */
async function readFingerprintWithRetry(
  url: string,
  read: (url: string) => Promise<DatabaseFingerprint>,
  attempts: number,
  sleep: (ms: number) => Promise<void>
): Promise<DatabaseFingerprint> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await read(url);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
      }
    }
  }
  throw lastError;
}

/**
 * Set uniqueness over every store that owns its own database. Fail-closed: a probe that cannot
 * answer returns NOT distinct, because "distinct" is a positive claim a failed probe cannot support.
 *
 * Same-cluster-different-database policy (unchanged from the pairwise probe): two databases inside
 * the SAME cluster (same system identifier, different current_database()) are reported distinct.
 * They are genuinely separate Postgres databases with separate WAL-visible state for our purposes.
 *
 * An ALIASED shard never appears in `targets`. It shares its target's client by reference, so it is
 * not its own database and inclusion would guarantee a duplicate. See nonAliasedShards.
 */
export async function probeDistinctStores(
  targets: DistinctTarget[],
  opts?: DistinctProbeOptions
): Promise<{ distinct: true } | { distinct: false; reason: string }> {
  if (targets.length < 2) {
    return { distinct: true };
  }

  const read = opts?.readFingerprint ?? readDatabaseFingerprint;
  const attempts = opts?.attempts ?? DEFAULT_PROBE_ATTEMPTS;
  const sleep = opts?.sleep ?? defaultSleep;

  try {
    // Retry per TARGET, not around the whole set: one slow shard must not re-probe the stores that
    // already answered. A duplicate verdict below is final and is never retried.
    const fingerprints = await Promise.all(
      targets.map((t) => readFingerprintWithRetry(t.url, read, attempts, sleep))
    );

    const seen = new Map<string, string>();
    for (const [index, target] of targets.entries()) {
      const fingerprint = fingerprints[index];
      const key = `${fingerprint.systemIdentifier}/${fingerprint.databaseName}`;
      const first = seen.get(key);
      if (first !== undefined) {
        const reason =
          `run-ops stores "${first}" and "${target.id}" resolve to the SAME physical database ` +
          `(systemIdentifier=${fingerprint.systemIdentifier}, database=${fingerprint.databaseName}); ` +
          "refusing to enable split — pooler/replica likely.";
        opts?.logger?.warn(reason);
        return { distinct: false, reason };
      }
      seen.set(key, target.id);
    }

    return { distinct: true };
  } catch (error) {
    const reason =
      `distinct-db sentinel probe failed after ${opts?.attempts ?? DEFAULT_PROBE_ATTEMPTS} ` +
      `attempt(s); failing closed (single-DB). ${String(error)}`;
    opts?.logger?.warn(reason, { error });
    return { distinct: false, reason };
  }
}

// The gen-1 pairwise entry point, kept as a thin delegate over a 2-element target list. Set
// uniqueness over one pair IS the pairwise compare, and this function's tests are the proof.
export async function probeDistinctDatabases(
  legacyUrl: string,
  newUrl: string,
  opts?: DistinctProbeOptions
): Promise<{ distinct: true } | { distinct: false; reason: string }> {
  return probeDistinctStores(
    [
      { id: "legacy", url: legacyUrl },
      { id: "new", url: newUrl },
    ],
    opts
  );
}
