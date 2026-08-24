// Break-glass Redis -> Postgres reconstruction. Reverse direction only, for a retreat below
// redis-read after Postgres stopped being written. Never expected to run.
import type { Prisma, PrismaClient } from "@trigger.dev/database";
import type { Redis } from "@internal/redis";
import {
  snapshotKeys,
  cycleKey,
  isValidFor,
  type CompletedWaitpointRecord,
} from "./redisSnapshotStore.js";

export type BackfillEntry = {
  id: string;
  seq: number;
  raw: string;
  entry: Record<string, unknown>;
  cycle?: { cycleSeq: number; orderCount: number };
};
export type BackfillCycle = {
  cycleSeq: number;
  order: string[];
  records: CompletedWaitpointRecord[] | null;
};
export type RunBackfillData = {
  runId: string;
  entries: BackfillEntry[];
  cycles: Map<number, BackfillCycle>;
};
export type BackfillRow = {
  row: Prisma.TaskRunExecutionSnapshotUncheckedCreateInput;
  waitpointIds: string[];
};
export type BackfillReport = {
  unreconstructable: Array<{
    runId: string;
    snapshotId: string;
    reason: "no-cycle-pointer" | "cycle-without-records";
  }>;
};

// Reads the whole `e` hash and splits each field on its LAST `#`: a bare name is the entry body,
// `#s` is its seq, `#c` is its cycle pointer "<cycleSeq>:<orderCount>". Returns null when there is no
// `e` hash — the keyspace expired or never existed, nothing to reconstruct.
export async function readRunSnapshotsForBackfill(
  redis: Redis,
  runId: string,
  keyPrefix = ""
): Promise<RunBackfillData | null> {
  const k = snapshotKeys(runId);
  const hash = await redis.hgetall(keyPrefix + k.e);
  if (!hash || Object.keys(hash).length === 0) return null;

  const bodies = new Map<string, string>();
  const seqs = new Map<string, number>();
  const pointers = new Map<string, { cycleSeq: number; orderCount: number }>();
  for (const [field, value] of Object.entries(hash)) {
    const hashIdx = field.lastIndexOf("#");
    if (hashIdx === -1) {
      bodies.set(field, value);
      continue;
    }
    const id = field.slice(0, hashIdx);
    const suffix = field.slice(hashIdx + 1);
    if (suffix === "s") {
      seqs.set(id, Number(value));
    } else if (suffix === "c") {
      const [cs, oc] = value.split(":");
      pointers.set(id, { cycleSeq: Number(cs), orderCount: Number(oc) });
    }
  }

  const entries: BackfillEntry[] = [];
  for (const [id, raw] of bodies) {
    entries.push({
      id,
      seq: seqs.get(id) ?? 0,
      raw,
      entry: JSON.parse(raw) as Record<string, unknown>,
      cycle: pointers.get(id),
    });
  }
  entries.sort((a, b) => a.seq - b.seq);

  const cycles = new Map<number, BackfillCycle>();
  const wanted = new Set([...pointers.values()].map((p) => p.cycleSeq));
  for (const cs of wanted) {
    const wp = await redis.hgetall(keyPrefix + cycleKey(runId, cs));
    if (!wp || Object.keys(wp).length === 0) continue;
    cycles.set(cs, {
      cycleSeq: cs,
      order: wp.order ? (JSON.parse(wp.order) as string[]) : [],
      records: wp.records ? (JSON.parse(wp.records) as CompletedWaitpointRecord[]) : null,
    });
  }

  return { runId, entries, cycles };
}

// Pure. Maps read data to row + join inputs, and reports what cannot be faithfully reconstructed.
export function snapshotRowsFromRedis(data: RunBackfillData): {
  rows: BackfillRow[];
  report: BackfillReport;
} {
  const rows: BackfillRow[] = [];
  const report: BackfillReport = { unreconstructable: [] };

  for (const e of data.entries) {
    const j = e.entry;
    const error = (j.error ?? null) as string | null;
    let order: string[] = [];
    let waitpointIds: string[] = [];

    if (e.cycle) {
      const c = data.cycles.get(e.cycle.cycleSeq);
      if (!c) {
        report.unreconstructable.push({
          runId: data.runId,
          snapshotId: e.id,
          reason: "no-cycle-pointer",
        });
      } else {
        order = c.order;
        if (c.records === null) {
          report.unreconstructable.push({
            runId: data.runId,
            snapshotId: e.id,
            reason: "cycle-without-records",
          });
          waitpointIds = [...new Set(order)]; // best-effort: the index-bearing subset only
        } else {
          waitpointIds = [...new Set(c.records.map((r) => r.id))];
        }
      }
    }

    rows.push({
      waitpointIds,
      row: {
        id: e.id,
        engine: "V2",
        executionStatus: j.executionStatus as Prisma.TaskRunExecutionSnapshotUncheckedCreateInput["executionStatus"],
        description: j.description as string,
        isValid: isValidFor(j as { error?: unknown }),
        error,
        previousSnapshotId: (j.previousSnapshotId ?? null) as string | null,
        runId: j.runId as string,
        runStatus: j.runStatus as Prisma.TaskRunExecutionSnapshotUncheckedCreateInput["runStatus"],
        batchId: (j.batchId ?? null) as string | null,
        attemptNumber: (j.attemptNumber ?? null) as number | null,
        environmentId: j.environmentId as string,
        environmentType: j.environmentType as Prisma.TaskRunExecutionSnapshotUncheckedCreateInput["environmentType"],
        projectId: j.projectId as string,
        organizationId: j.organizationId as string,
        checkpointId: (j.checkpointId ?? null) as string | null,
        workerId: (j.workerId ?? null) as string | null,
        runnerId: (j.runnerId ?? null) as string | null,
        createdAt: new Date(String(j.createdAt)),
        completedWaitpointOrder: order,
        metadata: (j.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  return { rows, report };
}

// Writes rows then links. Links use the production FK-free path, NEVER Prisma `connect`: the
// _completedWaitpoints -> Waitpoint FK was dropped for the run-ops split, so a dangling waitpoint id
// is legal and `connect` would raise P2025 and abort the transaction. Legacy: raw INSERT ... ON
// CONFLICT DO NOTHING (A = snapshotId, B = waitpointId). Dedicated: createMany against the explicit
// CompletedWaitpoint model, since the implicit join table does not exist on that schema.
export async function applyBackfill(
  prisma: PrismaClient,
  rows: BackfillRow[],
  opts: { dryRun: boolean; schemaVariant: "legacy" | "dedicated" }
): Promise<{ written: number; linked: number }> {
  if (opts.dryRun || rows.length === 0) return { written: 0, linked: 0 };

  let written = 0;
  let linked = 0;
  for (const { row, waitpointIds } of rows) {
    const snapshotId = row.id as string; // always set by snapshotRowsFromRedis
    await prisma.$transaction(async (tx) => {
      await tx.taskRunExecutionSnapshot.create({ data: row });
      written += 1;
      if (waitpointIds.length === 0) return;
      if (opts.schemaVariant === "dedicated") {
        const client = tx as unknown as {
          completedWaitpoint: {
            createMany(args: {
              data: Array<{ snapshotId: string; waitpointId: string }>;
              skipDuplicates: boolean;
            }): Promise<unknown>;
          };
        };
        await client.completedWaitpoint.createMany({
          data: waitpointIds.map((waitpointId) => ({ snapshotId, waitpointId })),
          skipDuplicates: true,
        });
      } else {
        await tx.$executeRaw`
          INSERT INTO "_completedWaitpoints" ("A", "B")
          SELECT ${snapshotId}, w.id
          FROM unnest(${waitpointIds}::text[]) AS w(id)
          ON CONFLICT DO NOTHING`;
      }
      linked += waitpointIds.length;
    });
  }
  return { written, linked };
}
