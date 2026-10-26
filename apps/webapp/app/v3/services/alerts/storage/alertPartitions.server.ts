import { randomUUID } from "node:crypto";
import type { PrismaClient } from "~/db.server";

const SCHEMA = "public";
const PARENTS = ["AlertDelivery", "AlertEvent"] as const;
type Parent = (typeof PARENTS)[number];

const ALERT_HISTORY_RETENTION_DAYS = 90;
const ALERT_HISTORY_LOOKAHEAD_MONTHS = 2;
const MIN_LOOKAHEAD_MONTHS = 2;
const MAX_LOOKAHEAD_SCAN = 24;
const DDL_LOCK_TIMEOUT = "5s";
const DDL_STATEMENT_TIMEOUT = "60s";
const DDL_STATEMENT_TIMEOUT_MS = 60_000;
const CANCEL_GRACE_MS = 5_000;

type Month = { lo: Date; hi: Date; name: string };

function floorMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

function monthOf(parent: Parent, lo: Date): Month {
  const suffix = `${lo.getUTCFullYear()}${String(lo.getUTCMonth() + 1).padStart(2, "0")}`;
  return { lo, hi: addMonths(lo, 1), name: `${parent}_p${suffix}` };
}

function parseMonth(parent: Parent, name: string): Month | undefined {
  const m = name.match(/^Alert(?:Event|Delivery)_p(\d{4})(\d{2})$/);
  if (!m || !name.startsWith(`${parent}_p`)) return undefined;
  return monthOf(parent, new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)));
}

function qualified(name: string): string {
  if (!/^Alert(?:Event|Delivery)(?:_p\d{6})?$/.test(name)) {
    throw new Error(`refusing to use unexpected alert partition name: ${name}`);
  }
  return `"${SCHEMA}"."${name}"`;
}

async function attachedWithBounds(
  prisma: PrismaClient,
  parent: Parent,
  month: Month
): Promise<boolean> {
  const [row] = await prisma.$queryRawUnsafe<{ valid: boolean }[]>(
    `SELECT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
      WHERE c.oid = to_regclass($1)
        AND i.inhparent = to_regclass($2)
        AND NOT i.inhdetachpending
        AND pg_get_expr(c.relpartbound, c.oid) =
          format('FOR VALUES FROM (%L) TO (%L)', $3::timestamptz, $4::timestamptz)
    ) AS valid`,
    qualified(month.name),
    qualified(parent),
    month.lo.toISOString(),
    month.hi.toISOString()
  );
  return row?.valid === true;
}

class StuckDdlError extends Error {
  constructor() {
    super("deferred to the next run: the DDL was cancelled at the deadline");
  }
}

function assertBeforeDeadline(deadline?: number): void {
  if (deadline !== undefined && Date.now() >= deadline) {
    throw new Error("deferred to the next run: maintenance deadline reached");
  }
}

async function ddl(prisma: PrismaClient, statement: string, deadline?: number): Promise<void> {
  assertBeforeDeadline(deadline);
  await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '${DDL_LOCK_TIMEOUT}'`),
    prisma.$executeRawUnsafe(`SET LOCAL statement_timeout = '${DDL_STATEMENT_TIMEOUT}'`),
    prisma.$executeRawUnsafe(statement),
  ]);
}

async function standaloneDdl(
  prisma: PrismaClient,
  runId: string,
  statement: string,
  deadline?: number
): Promise<void> {
  assertBeforeDeadline(deadline);
  const limit = Math.min(
    DDL_STATEMENT_TIMEOUT_MS,
    deadline === undefined ? DDL_STATEMENT_TIMEOUT_MS : Math.max(0, deadline - Date.now())
  );
  const marker = `alerts-partitions:${runId}`;
  const query = prisma.$executeRawUnsafe(`/* ${marker} */ ${statement}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), limit);
  });
  try {
    if ((await Promise.race([query, timedOut])) !== "timeout") return;
  } finally {
    clearTimeout(timer);
  }
  await prisma
    .$queryRawUnsafe(
      `SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE query LIKE $1 AND state = 'active' AND pid <> pg_backend_pid()`,
      `%${marker}%`
    )
    .catch(() => {});
  await Promise.race([
    query.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, CANCEL_GRACE_MS)),
  ]);
  throw new StuckDdlError();
}

function deferredOf(name: string, error: unknown): DeferredPartition {
  return { name, message: error instanceof Error ? error.message : String(error) };
}

async function ensureMonth(
  prisma: PrismaClient,
  parent: Parent,
  month: Month,
  deadline?: number
): Promise<boolean> {
  const [existing] = await prisma.$queryRawUnsafe<{ oid: string | null }[]>(
    `SELECT to_regclass($1)::text AS oid`,
    qualified(month.name)
  );
  if (existing?.oid == null) {
    await ddl(
      prisma,
      `CREATE TABLE IF NOT EXISTS ${qualified(month.name)} PARTITION OF ${qualified(parent)} ` +
        `FOR VALUES FROM ('${month.lo.toISOString()}') TO ('${month.hi.toISOString()}')`,
      deadline
    );
  }
  if (!(await attachedWithBounds(prisma, parent, month))) {
    throw new Error(`${month.name} is not attached to ${parent} with the expected UTC bounds`);
  }
  return existing?.oid == null;
}

async function listChildren(
  prisma: PrismaClient,
  parent: Parent
): Promise<{ name: string; pending: boolean }[]> {
  return prisma.$queryRawUnsafe<{ name: string; pending: boolean }[]>(
    `SELECT c.relname::text AS name, i.inhdetachpending AS pending
     FROM pg_inherits i
     JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = to_regclass($1)
     ORDER BY c.relname`,
    qualified(parent)
  );
}

async function dropExpiredLeftovers(
  prisma: PrismaClient,
  parent: Parent,
  cutoff: Date,
  result: EnsureAlertHistoryPartitionsResult,
  deadline?: number
): Promise<void> {
  const leftovers = await prisma.$queryRawUnsafe<{ name: string }[]>(
    `SELECT c.relname::text AS name FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r'
       AND c.relname ~ $2
       AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)`,
    SCHEMA,
    `^${parent}_p[0-9]{6}$`
  );
  for (const { name } of leftovers) {
    const month = parseMonth(parent, name);
    if (!month || month.hi.getTime() > cutoff.getTime()) continue;
    try {
      await ddl(prisma, `DROP TABLE IF EXISTS ${qualified(name)}`, deadline);
      result.dropped.push(name);
    } catch (error) {
      result.deferred.push(deferredOf(name, error));
    }
  }
}

async function retire(
  prisma: PrismaClient,
  runId: string,
  parent: Parent,
  cutoff: Date,
  result: EnsureAlertHistoryPartitionsResult,
  deadline?: number
): Promise<void> {
  for (const child of await listChildren(prisma, parent)) {
    if (!child.pending) continue;
    try {
      await ddl(
        prisma,
        `ALTER TABLE ${qualified(parent)} DETACH PARTITION ${qualified(child.name)} FINALIZE`,
        deadline
      );
    } catch (error) {
      result.deferred.push(deferredOf(child.name, error));
    }
  }
  await dropExpiredLeftovers(prisma, parent, cutoff, result, deadline);

  for (const child of await listChildren(prisma, parent)) {
    const month = parseMonth(parent, child.name);
    if (child.pending || !month || month.hi.getTime() > cutoff.getTime()) continue;
    try {
      if (!(await attachedWithBounds(prisma, parent, month))) {
        throw new Error(`${child.name} does not have the expected UTC bounds, not dropping`);
      }
      await standaloneDdl(
        prisma,
        runId,
        `ALTER TABLE ${qualified(parent)} DETACH PARTITION ${qualified(child.name)} CONCURRENTLY`,
        deadline
      );
      await ddl(prisma, `DROP TABLE IF EXISTS ${qualified(child.name)}`, deadline);
      result.dropped.push(child.name);
    } catch (error) {
      result.deferred.push(deferredOf(child.name, error));
      if (error instanceof StuckDdlError) throw error;
    }
  }
}

async function remainingLookahead(
  prisma: PrismaClient,
  parent: Parent,
  now: Date
): Promise<number> {
  const attached = new Set(
    (await listChildren(prisma, parent)).filter((c) => !c.pending).map((c) => c.name)
  );
  const current = floorMonthUTC(now);
  if (!attached.has(monthOf(parent, current).name)) return 0;
  let months = 0;
  while (
    months < MAX_LOOKAHEAD_SCAN &&
    attached.has(monthOf(parent, addMonths(current, months + 1)).name)
  ) {
    months++;
  }
  return months;
}

export type EnsureAlertHistoryPartitionsOptions = {
  now: Date;
  retentionDays?: number;
  lookaheadMonths?: number;
  deadline?: number;
};

export type DeferredPartition = { name: string; message: string };

export type EnsureAlertHistoryPartitionsResult = {
  created: string[];
  dropped: string[];
  deferred: DeferredPartition[];
  lookaheadMonths: number;
  warning?: string;
  connectionStuck?: boolean;
};

export async function ensureAlertHistoryPartitions(
  prisma: PrismaClient,
  options: EnsureAlertHistoryPartitionsOptions
): Promise<EnsureAlertHistoryPartitionsResult> {
  const runId = randomUUID();
  const retentionDays = options.retentionDays ?? ALERT_HISTORY_RETENTION_DAYS;
  const lookahead = options.lookaheadMonths ?? ALERT_HISTORY_LOOKAHEAD_MONTHS;
  const cutoff = new Date(options.now.getTime() - retentionDays * 86_400_000);
  const first = floorMonthUTC(cutoff);
  const last = addMonths(floorMonthUTC(options.now), lookahead);

  const result: EnsureAlertHistoryPartitionsResult = {
    created: [],
    dropped: [],
    deferred: [],
    lookaheadMonths: 0,
  };

  for (const parent of PARENTS) {
    for (let lo = first; lo.getTime() <= last.getTime(); lo = addMonths(lo, 1)) {
      const month = monthOf(parent, lo);
      try {
        if (await ensureMonth(prisma, parent, month, options.deadline))
          result.created.push(month.name);
      } catch (error) {
        result.deferred.push(deferredOf(month.name, error));
      }
    }
  }

  for (const parent of PARENTS) {
    try {
      await retire(prisma, runId, parent, cutoff, result, options.deadline);
    } catch (error) {
      if (error instanceof StuckDdlError) {
        result.connectionStuck = true;
        return result;
      }
      result.deferred.push(deferredOf(parent, error));
    }
  }

  try {
    const remaining = await Promise.all(
      PARENTS.map((parent) => remainingLookahead(prisma, parent, options.now))
    );
    result.lookaheadMonths = Math.min(...remaining);
  } catch (error) {
    result.deferred.push(deferredOf("lookahead", error));
  }
  if (result.lookaheadMonths < MIN_LOOKAHEAD_MONTHS) {
    result.warning = `alert history partitions cover only ${result.lookaheadMonths} month(s) ahead`;
  }

  return result;
}
