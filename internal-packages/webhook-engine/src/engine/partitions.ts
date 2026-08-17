import type { WebhookDatabase } from "@trigger.dev/database";

// Two identifier forms for the PascalCase Prisma table name. DDL must DOUBLE-QUOTE
// (Postgres folds unquoted identifiers to lowercase); pg_class.relname stores the
// bare case-preserved name, so catalog lookups bind the bare form.
const PARENT_DDL = `"WebhookDelivery"`;
const PARENT_NAME = `WebhookDelivery`;

// ---------------------------------------------------------------------------
// Day-bucket math (everything in UTC, matching how the migration writes bounds)
// ---------------------------------------------------------------------------

export type Bucket = { lo: Date; hi: Date; name: string }; // name bare, quoted at SQL build

export function floorDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

export function partitionName(lo: Date): string {
  const y = lo.getUTCFullYear();
  const m = String(lo.getUTCMonth() + 1).padStart(2, "0");
  const day = String(lo.getUTCDate()).padStart(2, "0");
  return `WebhookDelivery_${y}_${m}_${day}`; // bare Prisma table name
}

export function dayBucket(lo: Date): Bucket {
  const floored = floorDayUTC(lo);
  const hi = addDays(floored, 1);
  return { lo: floored, hi, name: partitionName(floored) };
}

/** All day buckets covering [start, end] inclusive of the day containing end. */
function dayBuckets(start: Date, end: Date): Bucket[] {
  const out: Bucket[] = [];
  let cur = floorDayUTC(start);
  const last = floorDayUTC(end);
  while (cur.getTime() <= last.getTime()) {
    out.push(dayBucket(cur));
    cur = addDays(cur, 1);
  }
  return out;
}

// Identifiers are built only from our own YYYY_MM_DD naming, never user input, so
// inlining them (and the bound literals, which Postgres requires as constants in DDL)
// is safe. We still assert the shape as a belt-and-braces guard. Caller quotes: `"${safeName(b.name)}"`.
function safeName(name: string): string {
  if (!/^WebhookDelivery_\d{4}_\d{2}_\d{2}$/.test(name)) {
    throw new Error(`refusing to use unexpected partition name: ${name}`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// Create / detach / drop primitives
// ---------------------------------------------------------------------------

export async function partitionExists(prisma: WebhookDatabase, name: string): Promise<boolean> {
  // to_regclass takes a quoted identifier string so it preserves the PascalCase. Cast to text:
  // Prisma's query engine can't deserialize the raw regclass OID type.
  const r = await prisma.$queryRawUnsafe<{ oid: string | null }[]>(
    `SELECT to_regclass($1)::text AS oid`,
    `"${safeName(name)}"`
  );
  return r[0]?.oid != null;
}

/**
 * Create one dated child as a true PARTITION OF the parent (inherits the parent indexes, no
 * validating scan). There is no DEFAULT partition, so the lookahead window MUST stay ahead of
 * ingest: an insert whose createdAt has no matching child errors instead of landing in a default.
 */
export async function createPartition(
  prisma: WebhookDatabase,
  b: Bucket
): Promise<"created" | "exists"> {
  if (await partitionExists(prisma, b.name)) return "exists";
  const name = `"${safeName(b.name)}"`;
  await prisma.$executeRawUnsafe(
    `CREATE TABLE ${name} PARTITION OF ${PARENT_DDL} ` +
      `FOR VALUES FROM ('${b.lo.toISOString()}') TO ('${b.hi.toISOString()}')`
  );
  return "created";
}

/**
 * Detach a child without blocking ingest: CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE on the
 * parent (no conflict with the ROW EXCLUSIVE that inserts hold) and waits just for in-flight txns
 * to finish. It MUST run outside a transaction block, so it goes out as a standalone statement.
 */
export async function detachPartitionConcurrently(
  prisma: WebhookDatabase,
  name: string
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE ${PARENT_DDL} DETACH PARTITION "${safeName(name)}" CONCURRENTLY`
  );
}

/** Drop a (now standalone, post-detach) table. With no partition attachment it takes no parent lock. */
export async function dropPartition(prisma: WebhookDatabase, name: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${safeName(name)}"`);
}

/**
 * Clean up a detach a crash left half-done, so the next retention pass can proceed:
 *  (a) a child stuck "pending detach" (interrupted mid-CONCURRENTLY) is FINALIZEd then dropped —
 *      Postgres allows only one pending detach at a time, so this must run before any new detach;
 *  (b) a child fully detached but not yet dropped is a standalone leftover table to drop.
 */
export async function recoverInterruptedDetaches(prisma: WebhookDatabase): Promise<void> {
  const pending = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT c.relname::text AS name FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = $1 AND i.inhdetachpending`,
    PARENT_NAME
  );
  for (const { name } of pending) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE ${PARENT_DDL} DETACH PARTITION "${safeName(name)}" FINALIZE`
    );
    await dropPartition(prisma, name);
  }

  const leftovers = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT c.relname::text AS name FROM pg_class c
     WHERE c.relkind = 'r'
       AND c.relname ~ '^WebhookDelivery_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
       AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)`
  );
  for (const { name } of leftovers) {
    await dropPartition(prisma, name);
  }
}

// ---------------------------------------------------------------------------
// The in-app manager (what the @internal/webhook-engine ensurePartitions cron runs)
// ---------------------------------------------------------------------------

export type EnsureOptions = {
  now: Date;
  lookaheadDays: number; // pre-create this many days ahead (7 to 14); MUST stay ahead of ingest
  retentionDays: number; // keep this many days back; drop colder children
};

export type EnsureResult = {
  created: string[];
  dropped: string[];
  existing: string[];
  deferred: string[]; // children we couldn't detach/drop this run; retried next run
};

export async function ensurePartitions(
  prisma: WebhookDatabase,
  opts: EnsureOptions
): Promise<EnsureResult> {
  const today = floorDayUTC(opts.now);
  const start = addDays(today, -opts.retentionDays);
  const end = addDays(today, opts.lookaheadDays);

  const result: EnsureResult = { created: [], dropped: [], existing: [], deferred: [] };

  for (const b of dayBuckets(start, end)) {
    const outcome = await createPartition(prisma, b);
    if (outcome === "created") result.created.push(b.name);
    else result.existing.push(b.name);
  }

  // Finish any detach a prior run left half-done, then concurrently detach + drop each dated child
  // whose whole range is older than the retention window. CONCURRENTLY keeps ingest unblocked; a
  // child we can't process now (e.g. a transient error) is left for the next run.
  await recoverInterruptedDetaches(prisma);
  for (const child of await listDatedPartitions(prisma)) {
    if (child.hi.getTime() <= start.getTime()) {
      try {
        await detachPartitionConcurrently(prisma, child.name);
        await dropPartition(prisma, child.name);
        result.dropped.push(child.name);
      } catch {
        result.deferred.push(child.name);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

export type PartitionInfo = {
  name: string;
  bound: string;
  approxRows: number;
  bytes: number;
  lo?: Date;
  hi?: Date;
};

export async function listPartitions(prisma: WebhookDatabase): Promise<PartitionInfo[]> {
  const rows = await prisma.$queryRawUnsafe<
    { name: string; bound: string; approx_rows: bigint; bytes: bigint }[]
  >(
    `SELECT c.relname::text AS name,
            pg_get_expr(c.relpartbound, c.oid) AS bound,
            c.reltuples::bigint AS approx_rows,
            pg_total_relation_size(c.oid) AS bytes
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = $1
     ORDER BY c.relname`,
    PARENT_NAME
  );
  return rows.map((row) => {
    let lo: Date | undefined;
    let hi: Date | undefined;
    const m = row.name.match(/^WebhookDelivery_(\d{4})_(\d{2})_(\d{2})$/);
    if (m) {
      lo = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
      hi = addDays(lo, 1);
    }
    return {
      name: row.name,
      bound: row.bound,
      approxRows: Number(row.approx_rows),
      bytes: Number(row.bytes),
      lo,
      hi,
    };
  });
}

export async function listDatedPartitions(
  prisma: WebhookDatabase
): Promise<Required<Pick<PartitionInfo, "name" | "lo" | "hi">>[]> {
  const all = await listPartitions(prisma);
  return all.filter((p) => p.lo && p.hi).map((p) => ({ name: p.name, lo: p.lo!, hi: p.hi! }));
}
