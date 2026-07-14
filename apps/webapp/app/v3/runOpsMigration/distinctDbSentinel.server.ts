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

export async function probeDistinctDatabases(
  legacyUrl: string,
  newUrl: string,
  opts?: { logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void } }
): Promise<{ distinct: true } | { distinct: false; reason: string }> {
  try {
    const [legacy, next] = await Promise.all([
      readDatabaseFingerprint(legacyUrl),
      readDatabaseFingerprint(newUrl),
    ]);
    const sameCluster = legacy.systemIdentifier === next.systemIdentifier;
    const sameDb = sameCluster && legacy.databaseName === next.databaseName;
    // Same-cluster-different-database policy: two databases inside the SAME cluster
    // (same system identifier, different current_database()) are reported distinct: true.
    // That is acceptable — they are genuinely separate Postgres databases with separate
    // WAL-visible state for our purposes, and the Cloud topology always uses separate
    // clusters anyway. A stricter "must be a different cluster" policy would gate on
    // sameCluster alone; that is flagged as an open question, not decided here.
    if (sameDb) {
      const reason =
        "run-ops legacy and new URLs resolve to the SAME physical database " +
        `(systemIdentifier=${legacy.systemIdentifier}, database=${legacy.databaseName}); ` +
        "refusing to enable split — pooler/replica likely.";
      opts?.logger?.warn(reason);
      return { distinct: false, reason };
    }
    return { distinct: true };
  } catch (error) {
    const reason = `distinct-db sentinel probe failed; failing closed (single-DB). ${String(error)}`;
    opts?.logger?.warn(reason, { error });
    return { distinct: false, reason };
  }
}
