// Compare-mode read comparator: PURE diff layer. It NEVER serves a read — it takes results the caller
// already obtained and reports how the two stores disagree, by field, with a class. Type-only imports
// of client types, so this module holds no Redis or Prisma client (proven by the isolation test).
import type { Prisma } from "@trigger.dev/database";
import type { SnapshotRead } from "./redisSnapshotStore.js";

export type DivergenceClass =
  | "missingInRedis"
  | "missingInPg"
  | "scalar"
  | "order"
  | "waitpointIdSet"
  | "validity"
  | "unknownField"
  // Reserved shared vocabulary for the payload-comparing layer a later ticket adds. This module
  // compares id sets and order, not record payloads, so it never emits this — a rotated idempotency
  // key does not change a waitpoint id. Kept in the union so the metric tag space stays stable.
  | "expected:rotatedIdempotencyKey"
  | "expected:redisSurplusAtCursorTie";

export type SnapshotDivergence = {
  field: string;
  class: DivergenceClass;
  pg?: unknown;
  redis?: unknown;
};

export type NormalizedSnapshot = {
  [k: string]: unknown;
  id: string;
  createdAt: number; // ms
  updatedAt: number; // ms
  completedWaitpointOrder: string[];
  waitpointIdSet: string[];
  previousSnapshotId?: string | null;
};

// The 22 compared entry columns. EXCLUDED_FIELDS names the columns deliberately not compared; any key
// on a normalized entry that is on neither list raises `unknownField`, so a new column fails loudly.
export const COMPARED_FIELDS = [
  "id", "engine", "executionStatus", "description", "isValid", "error", "previousSnapshotId",
  "runId", "runStatus", "batchId", "attemptNumber", "environmentId", "environmentType",
  "projectId", "organizationId", "checkpointId", "workerId", "runnerId", "createdAt",
  "updatedAt", "metadata",
] as const;

// lastHeartbeatAt: Postgres-only, never written by the current engine. Waitpoint/checkpoint payloads:
// expanded by the run-engine resolver, out of this module's scope.
export const EXCLUDED_FIELDS = ["lastHeartbeatAt", "checkpoint", "completedWaitpoints"] as const;

const SCALAR_FIELDS = COMPARED_FIELDS.filter((f) => f !== "metadata");

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function normalizeFromPg(
  row: Prisma.TaskRunExecutionSnapshotGetPayload<{ include: { completedWaitpoints: true } }>
): NormalizedSnapshot {
  const wps = (row.completedWaitpoints ?? []) as Array<{ id: string }>;
  return {
    id: row.id,
    engine: row.engine,
    executionStatus: row.executionStatus,
    description: row.description,
    isValid: row.isValid,
    error: row.error ?? null,
    previousSnapshotId: row.previousSnapshotId ?? null,
    runId: row.runId,
    runStatus: row.runStatus,
    batchId: row.batchId ?? null,
    attemptNumber: row.attemptNumber ?? null,
    environmentId: row.environmentId,
    environmentType: row.environmentType,
    projectId: row.projectId,
    organizationId: row.organizationId,
    checkpointId: row.checkpointId ?? null,
    workerId: row.workerId ?? null,
    runnerId: row.runnerId ?? null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    metadata: row.metadata ?? null,
    completedWaitpointOrder: [...(row.completedWaitpointOrder ?? [])],
    waitpointIdSet: [...wps.map((w) => w.id)].sort(),
  };
}

export function normalizeFromRedis(read: SnapshotRead): NormalizedSnapshot {
  const e = read.entry as Record<string, unknown>;
  const createdAtMs = new Date(String(e.createdAt)).getTime();
  const order = read.completedWaitpointIds?.order ?? [];
  const idSet = [...(read.completedWaitpointIds?.distinctIds ?? [])].sort();
  return {
    id: read.id,
    engine: (e.engine ?? "V2") as string,
    executionStatus: e.executionStatus as string,
    description: e.description as string,
    isValid: read.isValid,
    error: (e.error ?? null) as string | null,
    previousSnapshotId: (e.previousSnapshotId ?? null) as string | null,
    runId: e.runId as string,
    runStatus: e.runStatus as string,
    batchId: (e.batchId ?? null) as string | null,
    attemptNumber: (e.attemptNumber ?? null) as number | null,
    environmentId: e.environmentId as string,
    environmentType: e.environmentType as string,
    projectId: e.projectId as string,
    organizationId: e.organizationId as string,
    checkpointId: (e.checkpointId ?? null) as string | null,
    workerId: (e.workerId ?? null) as string | null,
    runnerId: (e.runnerId ?? null) as string | null,
    createdAt: createdAtMs,
    updatedAt: createdAtMs, // write-once row: updatedAt equals createdAt
    metadata: e.metadata ?? null,
    completedWaitpointOrder: [...order],
    waitpointIdSet: idSet,
  };
}

function sameArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function fieldDivergences(pg: NormalizedSnapshot, redis: NormalizedSnapshot): SnapshotDivergence[] {
  const out: SnapshotDivergence[] = [];
  const known = new Set<string>([
    ...COMPARED_FIELDS,
    ...EXCLUDED_FIELDS,
    "completedWaitpointOrder",
    "waitpointIdSet",
  ]);

  for (const f of SCALAR_FIELDS) {
    if (pg[f] !== redis[f]) {
      out.push({
        field: f,
        class: f === "isValid" ? "validity" : "scalar",
        pg: pg[f],
        redis: redis[f],
      });
    }
  }
  if (canonicalJson(pg.metadata) !== canonicalJson(redis.metadata)) {
    out.push({ field: "metadata", class: "scalar", pg: pg.metadata, redis: redis.metadata });
  }
  if (!sameArray(pg.completedWaitpointOrder, redis.completedWaitpointOrder)) {
    out.push({
      field: "completedWaitpointOrder",
      class: "order",
      pg: pg.completedWaitpointOrder,
      redis: redis.completedWaitpointOrder,
    });
  }
  if (!sameArray(pg.waitpointIdSet, redis.waitpointIdSet)) {
    out.push({
      field: "waitpointIdSet",
      class: "waitpointIdSet",
      pg: pg.waitpointIdSet,
      redis: redis.waitpointIdSet,
    });
  }
  for (const k of Object.keys(redis)) {
    if (!known.has(k)) out.push({ field: k, class: "unknownField", redis: redis[k] });
  }
  return out;
}

export function diffLatest(
  pg: NormalizedSnapshot | null,
  redis: NormalizedSnapshot | null
): SnapshotDivergence[] {
  if (pg && !redis) return [{ field: pg.id, class: "missingInRedis", pg }];
  if (redis && !pg) return [{ field: redis.id, class: "missingInPg", redis }];
  if (!pg || !redis) return [];
  return fieldDivergences(pg, redis);
}

export function diffSince(args: {
  pg: NormalizedSnapshot[];
  redis: NormalizedSnapshot[];
  cursor: { id: string; createdAtMs: number };
}): SnapshotDivergence[] {
  const { pg, redis, cursor } = args;
  const byId = (xs: NormalizedSnapshot[]) => new Map(xs.map((x) => [x.id, x]));
  const pgMap = byId(pg);
  const redisMap = byId(redis);
  const out: SnapshotDivergence[] = [];

  // Present on both: field-diff.
  for (const [id, p] of pgMap) {
    const r = redisMap.get(id);
    if (r) out.push(...fieldDivergences(p, r));
  }
  // Postgres-only: ALWAYS a lost append. A same-ms tie can never surface here, because Postgres's own
  // window drops the same-ms entry too. So there is no "expected tie" on this side.
  for (const [id, p] of pgMap) {
    if (!redisMap.has(id)) out.push({ field: id, class: "missingInRedis", pg: p });
  }
  // Redis-only: expected ONLY when it is a chain boundary sitting exactly on the cursor ms (the
  // id-cursor getSince path keeps a same-ms entry that Postgres's `> cursor` drops). Anything else is
  // a real surplus.
  for (const [id, r] of redisMap) {
    if (pgMap.has(id)) continue;
    const isTie = r.createdAt === cursor.createdAtMs && r.previousSnapshotId === cursor.id;
    out.push({
      field: id,
      class: isTie ? "expected:redisSurplusAtCursorTie" : "missingInPg",
      redis: r,
    });
  }
  return out;
}
