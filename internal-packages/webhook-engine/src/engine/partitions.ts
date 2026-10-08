import {
  WEBHOOK_DELIVERY_RETENTION_CLASSES,
  webhookDeliveryRetentionClass,
  type WebhookDeliveryRetentionClass,
} from "@trigger.dev/core/v3/isomorphic";
import type { WebhookDatabase } from "@trigger.dev/database";

const ROOT_DDL = `"WebhookDelivery"`;
const ROOT_NAME = `WebhookDelivery`;

const CLASS_PARENT_PATTERN = /^WebhookDelivery_r(\d{1,4})$/;
const LEAF_PATTERN = /^WebhookDelivery_r(\d{1,4})_(\d{4})_(\d{2})_(\d{2})$/;

/**
 * One leaf of the delivery table. `WebhookDelivery` is LIST-partitioned on `retentionDays` into one
 * sub-parent per retention class (`WebhookDelivery_r30`), each RANGE-partitioned on `createdAt` into
 * day or week leaves (`WebhookDelivery_r30_2026_10_08`). Bounds are UTC.
 */
export type Bucket = { retentionDays: number; lo: Date; hi: Date; name: string };

export function floorDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/** The Monday (UTC) starting the week that contains `d`. */
function floorWeekUTC(d: Date): Date {
  const day = floorDayUTC(d);
  return addDays(day, -((day.getUTCDay() + 6) % 7));
}

export function classParentName(retentionDays: number): string {
  return `WebhookDelivery_r${retentionDays}`;
}

export function partitionName(retentionDays: number, lo: Date): string {
  const y = lo.getUTCFullYear();
  const m = String(lo.getUTCMonth() + 1).padStart(2, "0");
  const day = String(lo.getUTCDate()).padStart(2, "0");
  return `WebhookDelivery_r${retentionDays}_${y}_${m}_${day}`;
}

/** The leaf of a retention class that holds deliveries created at `at`. */
export function bucketFor(retentionClass: WebhookDeliveryRetentionClass, at: Date): Bucket {
  const lo = retentionClass.period === "week" ? floorWeekUTC(at) : floorDayUTC(at);
  const hi = addDays(lo, retentionClass.period === "week" ? 7 : 1);
  return {
    retentionDays: retentionClass.days,
    lo,
    hi,
    name: partitionName(retentionClass.days, lo),
  };
}

/** Every leaf of a class covering [start, end], including the one containing `end`. */
function bucketsCovering(
  retentionClass: WebhookDeliveryRetentionClass,
  start: Date,
  end: Date
): Bucket[] {
  const out: Bucket[] = [];
  let bucket = bucketFor(retentionClass, start);
  while (bucket.lo.getTime() <= end.getTime()) {
    out.push(bucket);
    bucket = bucketFor(retentionClass, bucket.hi);
  }
  return out;
}

/**
 * Identifiers and bound literals are inlined into DDL (Postgres requires constants there). They are
 * built only from our own naming, never user input; the shape is still asserted.
 */
function safeName(name: string): string {
  if (!CLASS_PARENT_PATTERN.test(name) && !LEAF_PATTERN.test(name)) {
    throw new Error(`refusing to use unexpected partition name: ${name}`);
  }
  return name;
}

function safeDays(retentionDays: number): number {
  if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
    throw new Error(`refusing to use unexpected retention: ${retentionDays}`);
  }
  return retentionDays;
}

/**
 * Whether a table exists. `to_regclass` takes the quoted identifier so it preserves the PascalCase,
 * and the result is cast to text because Prisma can't deserialize the raw regclass OID type.
 */
export async function partitionExists(prisma: WebhookDatabase, name: string): Promise<boolean> {
  const r = await prisma.$queryRawUnsafe<{ oid: string | null }[]>(
    `SELECT to_regclass($1)::text AS oid`,
    `"${safeName(name)}"`
  );
  return r[0]?.oid != null;
}

/** A same-named table is usable only if it is attached to `parent` with exactly `bound`. */
async function assertAttached(
  prisma: WebhookDatabase,
  name: string,
  parent: string,
  bound: string
): Promise<void> {
  const [partition] = await prisma.$queryRawUnsafe<{ valid: boolean }[]>(
    `SELECT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      WHERE c.oid = to_regclass($1)
        AND i.inhparent = to_regclass($2)
        AND NOT i.inhdetachpending
        AND pg_get_expr(c.relpartbound, c.oid) = $3
    ) AS valid`,
    `"${name}"`,
    `"${parent}"`,
    bound
  );
  if (!partition?.valid) {
    throw new Error(`${name} is not attached to ${parent} with the expected bounds`);
  }
}

/**
 * Create `name` with `ddl` unless it exists, under a short lock_timeout so a long transaction on the
 * parent defers this run instead of queueing every insert behind our lock. Safe when runs overlap:
 * the loser's CREATE errors, is re-checked against the catalog and reported as "exists".
 */
async function createAttached(
  prisma: WebhookDatabase,
  name: string,
  ddl: string,
  verify: () => Promise<void>
): Promise<"created" | "exists"> {
  if (await partitionExists(prisma, name)) {
    await verify();
    return "exists";
  }
  try {
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '10s'`),
      prisma.$executeRawUnsafe(ddl),
    ]);
  } catch (error) {
    if (await partitionExists(prisma, name)) {
      await verify();
      return "exists";
    }
    throw error;
  }
  return "created";
}

/** Create a retention class's sub-parent, itself RANGE-partitioned on `createdAt`. */
export async function createClassParent(
  prisma: WebhookDatabase,
  retentionDays: number
): Promise<"created" | "exists"> {
  const days = safeDays(retentionDays);
  const name = safeName(classParentName(days));
  return createAttached(
    prisma,
    name,
    `CREATE TABLE "${name}" PARTITION OF ${ROOT_DDL} FOR VALUES IN (${days}) PARTITION BY RANGE ("createdAt")`,
    () => assertAttached(prisma, name, ROOT_NAME, `FOR VALUES IN (${days})`)
  );
}

/**
 * Create one leaf as a true PARTITION OF its class sub-parent (inherits the parent indexes, no
 * validating scan). There is no DEFAULT partition, so the lookahead window MUST stay ahead of
 * ingest: an insert whose class and createdAt have no leaf errors instead of landing in a default.
 */
export async function createPartition(
  prisma: WebhookDatabase,
  b: Bucket
): Promise<"created" | "exists"> {
  const parent = safeName(classParentName(safeDays(b.retentionDays)));
  const name = safeName(b.name);
  return createAttached(
    prisma,
    name,
    `CREATE TABLE "${name}" PARTITION OF "${parent}" ` +
      `FOR VALUES FROM ('${b.lo.toISOString()}') TO ('${b.hi.toISOString()}')`,
    async () => {
      const [{ bound } = { bound: "" }] = await prisma.$queryRawUnsafe<{ bound: string }[]>(
        `SELECT format('FOR VALUES FROM (%L) TO (%L)', $1::timestamp, $2::timestamp) AS bound`,
        b.lo.toISOString(),
        b.hi.toISOString()
      );
      await assertAttached(prisma, name, parent, bound);
    }
  );
}

/**
 * Detach a leaf without blocking ingest: CONCURRENTLY takes only SHARE UPDATE EXCLUSIVE on its class
 * sub-parent (no conflict with the ROW EXCLUSIVE that inserts hold) and waits just for in-flight
 * txns to finish. It MUST run outside a transaction block, so it goes out as a standalone statement.
 */
export async function detachPartitionConcurrently(
  prisma: WebhookDatabase,
  b: Pick<Bucket, "retentionDays" | "name">
): Promise<void> {
  const parent = safeName(classParentName(safeDays(b.retentionDays)));
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "${parent}" DETACH PARTITION "${safeName(b.name)}" CONCURRENTLY`
  );
}

/** Drop a (now standalone, post-detach) table. With no partition attachment it takes no parent lock. */
export async function dropPartition(prisma: WebhookDatabase, name: string): Promise<void> {
  await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${safeName(name)}"`);
}

/**
 * Clean up detaches a crash left half-done, so the next retention pass can proceed:
 *  (a) a leaf stuck "pending detach" (interrupted mid-CONCURRENTLY) is FINALIZEd then dropped.
 *      Postgres allows one pending detach per partitioned table, so each class sub-parent must be
 *      cleared before its next detach;
 *  (b) a leaf fully detached but not yet dropped is a standalone leftover table to drop.
 */
export async function recoverInterruptedDetaches(prisma: WebhookDatabase): Promise<void> {
  const pending = await prisma.$queryRawUnsafe<{ name: string; parent: string }[]>(
    `SELECT c.relname::text AS name, p.relname::text AS parent FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname ~ '^WebhookDelivery_r[0-9]+$' AND i.inhdetachpending`
  );
  for (const { name, parent } of pending) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "${safeName(parent)}" DETACH PARTITION "${safeName(name)}" FINALIZE`
    );
    await dropPartition(prisma, name);
  }

  const leftovers = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT c.relname::text AS name FROM pg_class c
     WHERE c.relkind = 'r'
       AND c.relname ~ '^WebhookDelivery_r[0-9]+_[0-9]{4}_[0-9]{2}_[0-9]{2}$'
       AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)`
  );
  for (const { name } of leftovers) {
    await dropPartition(prisma, name);
  }
}

export type EnsureOptions = {
  now: Date;
  /** Pre-create leaves covering this many days ahead. MUST stay ahead of ingest. */
  lookaheadDays: number;
  /** Defaults to every registered class. */
  classes?: readonly WebhookDeliveryRetentionClass[];
};

export type EnsureResult = {
  created: string[];
  dropped: string[];
  existing: string[];
  /** Leaves we couldn't detach or drop this run; retried next run. */
  deferred: string[];
  /** Partitions that belong to no registered class. Never touched. */
  unmanaged: string[];
};

/**
 * Create every class's sub-parent, today's leaf and the lookahead, without running retention. Safe
 * to repeat before enabling ingress. Never creates past leaves: ingest stamps `createdAt` at insert
 * time, so it never writes to one. Anything that backfills older rows (the dev delivery seed)
 * creates its own.
 */
export async function bootstrapPartitions(
  prisma: WebhookDatabase,
  opts: EnsureOptions
): Promise<Pick<EnsureResult, "created" | "existing">> {
  const result: Pick<EnsureResult, "created" | "existing"> = { created: [], existing: [] };
  const end = addDays(floorDayUTC(opts.now), opts.lookaheadDays);

  for (const retentionClass of opts.classes ?? WEBHOOK_DELIVERY_RETENTION_CLASSES) {
    await createClassParent(prisma, retentionClass.days);
    for (const b of bucketsCovering(retentionClass, opts.now, end)) {
      const outcome = await createPartition(prisma, b);
      if (outcome === "created") result.created.push(b.name);
      else result.existing.push(b.name);
    }
  }

  return result;
}

/**
 * Bootstrap, finish any detach a prior run left half-done, then concurrently detach and drop each
 * leaf whose whole range is older than its class's retention. A leaf we can't process now (e.g. a
 * transient error) is left for the next run.
 */
export async function ensurePartitions(
  prisma: WebhookDatabase,
  opts: EnsureOptions
): Promise<EnsureResult> {
  const result: EnsureResult = {
    ...(await bootstrapPartitions(prisma, opts)),
    dropped: [],
    deferred: [],
    unmanaged: [],
  };
  const today = floorDayUTC(opts.now);

  await recoverInterruptedDetaches(prisma);
  for (const leaf of await listAllPartitions(prisma)) {
    if (!leaf.managed) {
      result.unmanaged.push(leaf.name);
      continue;
    }
    if (addDays(leaf.hi, leaf.retentionDays).getTime() > today.getTime()) continue;
    try {
      await detachPartitionConcurrently(prisma, leaf);
      await dropPartition(prisma, leaf.name);
      result.dropped.push(leaf.name);
    } catch {
      result.deferred.push(leaf.name);
    }
  }

  return result;
}

export type DatedPartition = { name: string; retentionDays: number; lo: Date; hi: Date };

type ListedPartition = DatedPartition & { managed: boolean };

/**
 * Every leaf under a registered class sub-parent, plus anything else attached to the root or a
 * sub-parent that doesn't fit the scheme, reported as unmanaged so it's never dropped.
 */
async function listAllPartitions(prisma: WebhookDatabase): Promise<ListedPartition[]> {
  const rows = await prisma.$queryRawUnsafe<{ name: string; parent: string }[]>(
    `SELECT c.relname::text AS name, p.relname::text AS parent
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = $1 OR p.relname ~ '^WebhookDelivery_r[0-9]+$'
     ORDER BY c.relname`,
    ROOT_NAME
  );

  const out: ListedPartition[] = [];
  for (const row of rows) {
    const parentClass = CLASS_PARENT_PATTERN.exec(row.name);
    if (row.parent === ROOT_NAME && parentClass) {
      if (webhookDeliveryRetentionClass(Number(parentClass[1]))) continue;
    }
    const leaf = LEAF_PATTERN.exec(row.name);
    const retentionClass = leaf ? webhookDeliveryRetentionClass(Number(leaf[1])) : undefined;
    if (leaf && retentionClass && row.parent === classParentName(retentionClass.days)) {
      const lo = new Date(Date.UTC(Number(leaf[2]), Number(leaf[3]) - 1, Number(leaf[4])));
      out.push({ ...bucketFor(retentionClass, lo), name: row.name, managed: true });
      continue;
    }
    out.push({
      name: row.name,
      retentionDays: 0,
      lo: new Date(0),
      hi: new Date(0),
      managed: false,
    });
  }
  return out;
}

export async function listDatedPartitions(prisma: WebhookDatabase): Promise<DatedPartition[]> {
  return (await listAllPartitions(prisma))
    .filter((p) => p.managed)
    .map(({ name, retentionDays, lo, hi }) => ({ name, retentionDays, lo, hi }));
}

/**
 * The earliest point any registered class runs out of leaves: ingest into that class fails once it
 * passes. `undefined` when a class has no leaves at all.
 */
export function partitionsCoveredUntil(
  partitions: DatedPartition[],
  classes: readonly WebhookDeliveryRetentionClass[] = WEBHOOK_DELIVERY_RETENTION_CLASSES
): Date | undefined {
  let earliest: Date | undefined;
  for (const retentionClass of classes) {
    let newest: Date | undefined;
    for (const p of partitions) {
      if (p.retentionDays === retentionClass.days && (!newest || p.hi > newest)) newest = p.hi;
    }
    if (!newest) return undefined;
    if (!earliest || newest < earliest) earliest = newest;
  }
  return earliest;
}
