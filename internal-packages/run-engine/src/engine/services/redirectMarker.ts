import { Prisma, type PrismaClient } from "@trigger.dev/database";

/**
 * Redirect-marker / tombstone fencing primitive.
 *
 * A redirect-marker is written on the OLD run-ops database for a run BEFORE
 * any write for that run lands on the NEW run-ops database. Once the marker
 * exists, old-side workers/timers/sweepers MUST fence off (refuse to advance
 * the run on the old DB), so a crash mid-migration always resolves ownership
 * to exactly one database — the durable half of "single-owner-on-crash".
 *
 * HARD GATE: this primitive is part of the migration family. It MUST be
 * unreachable when the DB split is OFF (single-DB / self-host). The gate
 * (isSplitEnabled()) is enforced by the CALLERS, resolved
 * once at boot — never inside these functions on a per-run path. In a
 * single-DB install there is only one DB, so a tombstone there would fence
 * (and the migration would later delete) the only copy = data loss.
 *
 * CLIENT CONTRACT: the `RedirectMarkerClient` passed in MUST be the LEGACY /
 * OLD run-ops client (the `legacyRunOps.*` client), never the NEW one — the
 * marker lives on the source-of-migration DB. Passing the wrong client
 * defeats the fence. This is the caller's responsibility.
 *
 * Uses the SAFE raw-SQL API ($queryRaw/$executeRaw tagged templates) per the
 * run-engine convention; the constant table identifier is injected via
 * Prisma.raw, all values are bound params.
 */

const REDIRECT_MARKER_TABLE = "run_engine_redirect_markers";

export type RedirectMarker = {
  runId: string;
  targetDb: "NEW";
  markedAt: Date;
  reason: string;
};

export type WriteRedirectMarkerInput = {
  runId: string;
  reason: string;
};

/** Minimal SAFE Prisma surface the marker functions need (OLD run-ops client). */
export type RedirectMarkerClient = Pick<PrismaClient, "$queryRaw" | "$executeRaw">;

type RedirectMarkerRow = {
  run_id: string;
  marked_at: Date | string;
  reason: string;
};

function rowToMarker(row: RedirectMarkerRow): RedirectMarker {
  return {
    runId: row.run_id,
    targetDb: "NEW",
    markedAt: row.marked_at instanceof Date ? row.marked_at : new Date(row.marked_at),
    reason: row.reason,
  };
}

/**
 * Idempotent table + index creation. Call once at migration-service init,
 * not per-marker. SAFETY NET only — the canonical DDL is tracked out-of-band
 * in the FK-drop runbook.
 */
export async function ensureRedirectMarkerTable(client: RedirectMarkerClient): Promise<void> {
  await client.$executeRaw`
    CREATE TABLE IF NOT EXISTS ${Prisma.raw(REDIRECT_MARKER_TABLE)} (
      run_id text PRIMARY KEY,
      target_db text NOT NULL,
      marked_at timestamptz NOT NULL DEFAULT now(),
      reason text NOT NULL
    )`;
  // Backs orphan scans over stale markers.
  await client.$executeRaw`
    CREATE INDEX IF NOT EXISTS run_engine_redirect_markers_marked_at_idx
      ON ${Prisma.raw(REDIRECT_MARKER_TABLE)} (marked_at)`;
}

/**
 * Idempotent write of the redirect-marker for a run on the OLD run-ops DB.
 * First-writer-wins: ON CONFLICT DO NOTHING preserves the original markedAt
 * so the timestamp records when fencing began. Safe to retry.
 */
export async function writeRedirectMarker(
  client: RedirectMarkerClient,
  input: WriteRedirectMarkerInput
): Promise<void> {
  await client.$executeRaw`
    INSERT INTO ${Prisma.raw(REDIRECT_MARKER_TABLE)} (run_id, target_db, reason)
    VALUES (${input.runId}, ${"NEW"}, ${input.reason})
    ON CONFLICT (run_id) DO NOTHING`;
}

/** Read the marker for a run, or null if none. Safe on a replica. */
export async function readRedirectMarker(
  client: RedirectMarkerClient,
  runId: string
): Promise<RedirectMarker | null> {
  const rows = await client.$queryRaw<RedirectMarkerRow[]>`
    SELECT run_id, marked_at, reason
      FROM ${Prisma.raw(REDIRECT_MARKER_TABLE)}
     WHERE run_id = ${runId}
     LIMIT 1`;
  const row = rows[0];
  if (!row) {
    return null;
  }
  return rowToMarker(row);
}

/**
 * True iff a redirect-marker exists for the run. The single predicate
 * old-side systems call before advancing a run. Consumers add the CHECK
 * call sites; this unit only provides the predicate.
 */
export async function isFenced(client: RedirectMarkerClient, runId: string): Promise<boolean> {
  return (await readRedirectMarker(client, runId)) !== null;
}
