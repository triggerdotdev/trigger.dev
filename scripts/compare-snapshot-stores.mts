#!/usr/bin/env tsx
/**
 * Compares mirrored execution snapshots between Postgres and MemoryDB for runs created in a window.
 *
 * Read-only: Postgres is queried with SELECTs only, MemoryDB with HGETALL/ZRANGE/GET/EXISTS only.
 * Point both at replicas, with read-only credentials.
 *
 * USAGE:
 *   pnpm exec tsx scripts/compare-snapshot-stores.mts \
 *     --redis-url rediss://user:pass@host:6379 [--redis-cluster] \
 *     --control-plane-url postgresql://... --org org_a --org org_b \
 *     [--run-db-url postgresql://... ...] [--env env_x ...] \
 *     --from 2026-10-09T00:00:00Z --to 2026-10-12T00:00:00Z \
 *     [--settle-minutes 10] [--batch-size 500] [--pause-ms 100] [--limit 1000] [--out diffs.jsonl]
 *
 * Runs are listed from every --run-db-url (default: --control-plane-url). Pass each run database
 * once. Only runs whose birth snapshot is marked mirrored are compared. --limit caps how many
 * mirrored runs are compared: databases and environments are read in the order given, oldest run
 * first within each, so a limited run is not a sample across all of them.
 *
 * A run with any difference is read again from both stores before it counts, and is reported as
 * active if it moved in the meantime. A finished run whose MemoryDB keys are gone and whose last
 * snapshot is older than the MemoryDB retention for finished runs is skipped as expired.
 *
 * --check only tests the connections (one catalogue query per database, PING and a few constant-time
 * reads on MemoryDB) and exits; --env/--org/--from/--to are not needed for it.
 *
 * Exit code 0 when no settled run differs, 1 when one does, 2 on bad arguments.
 */
import { createWriteStream } from "node:fs";
import { finished } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { PrismaClient } from "@trigger.dev/database";
import {
  createRedisClient,
  createRedisClusterClient,
  type Cluster,
  type RedisClient,
} from "../internal-packages/redis/src/index.js";
import {
  entryFromSnapshotRow,
  isTerminalEntry,
  preparedUnitKey,
  protocolMarkerKey,
  snapshotKeys,
  snapshotResidencyFromMetadata,
  type SnapshotRowForEntry,
} from "../internal-packages/run-store/src/index.js";

type PostgresSnapshotRow = SnapshotRowForEntry & { isValid: boolean };

type RedisRunState = {
  /** The `e` hash, including its `<id>#s` / `<id>#c` sidecar fields. */
  entries: Record<string, string>;
  validIds: string[];
  head: string | null;
  prepared: boolean;
};

type SnapshotDiff =
  | { kind: "keyspace-missing" }
  | { kind: "missing-in-redis"; snapshotId: string }
  | { kind: "extra-in-redis"; snapshotId: string }
  | { kind: "unparseable"; snapshotId: string }
  | { kind: "field"; snapshotId: string; field: string; postgres: unknown; redis: unknown }
  | { kind: "valid-set"; snapshotId: string; postgresValid: boolean; redisIndexed: boolean }
  | { kind: "head"; postgres: string[]; redis: string | null }
  | { kind: "pending" };

type RunComparison = { runId: string; settled: boolean; diffs: SnapshotDiff[] };

type ComparisonSummary = {
  pass: boolean;
  runs: { settled: number; active: number };
  runsWithDiffs: { settled: number; active: number };
  diffsByKind: { settled: Record<string, number>; active: Record<string, number> };
};

function isSidecarField(field: string): boolean {
  return field.includes("#");
}

function compareEntry(snapshotId: string, expected: object, actual: object): SnapshotDiff[] {
  const diffs: SnapshotDiff[] = [];
  const fields = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const field of [...fields].sort()) {
    // Builders may write an explicit null where the row conversion omits the field.
    const postgres = (expected as Record<string, unknown>)[field] ?? undefined;
    const redis = (actual as Record<string, unknown>)[field] ?? undefined;
    if (!isDeepStrictEqual(postgres, redis)) {
      diffs.push({ kind: "field", snapshotId, field, postgres, redis });
    }
  }
  return diffs;
}

/** The latest valid Postgres snapshots. More than one when createdAt ties. */
function latestValid(rows: PostgresSnapshotRow[]): string[] {
  const valid = rows.filter((r) => r.isValid);
  if (valid.length === 0) return [];
  const latest = Math.max(...valid.map((r) => r.createdAt.getTime()));
  return valid.filter((r) => r.createdAt.getTime() === latest).map((r) => r.id);
}

function compareRun(rows: PostgresSnapshotRow[], redis: RedisRunState): SnapshotDiff[] {
  const diffs: SnapshotDiff[] = [];
  if (redis.prepared) diffs.push({ kind: "pending" });

  const redisIds = Object.keys(redis.entries).filter((f) => !isSidecarField(f));
  if (redisIds.length === 0) {
    if (rows.length > 0) diffs.push({ kind: "keyspace-missing" });
    return diffs;
  }

  const postgresIds = new Set(rows.map((r) => r.id));
  const indexed = new Set(redis.validIds);

  for (const r of rows) {
    const raw = redis.entries[r.id];
    if (raw === undefined) {
      diffs.push({ kind: "missing-in-redis", snapshotId: r.id });
      continue;
    }
    let entry: unknown;
    try {
      entry = JSON.parse(raw);
    } catch {
      diffs.push({ kind: "unparseable", snapshotId: r.id });
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      diffs.push({ kind: "unparseable", snapshotId: r.id });
      continue;
    }
    diffs.push(...compareEntry(r.id, entryFromSnapshotRow(r), entry));
    if (r.isValid !== indexed.has(r.id)) {
      diffs.push({
        kind: "valid-set",
        snapshotId: r.id,
        postgresValid: r.isValid,
        redisIndexed: indexed.has(r.id),
      });
    }
  }

  for (const id of redisIds) {
    if (!postgresIds.has(id)) diffs.push({ kind: "extra-in-redis", snapshotId: id });
  }
  for (const id of indexed) {
    if (!postgresIds.has(id)) {
      diffs.push({ kind: "valid-set", snapshotId: id, postgresValid: false, redisIndexed: true });
    }
  }

  const latest = latestValid(rows);
  if (latest.length > 0 && (redis.head === null || !latest.includes(redis.head))) {
    diffs.push({ kind: "head", postgres: latest, redis: redis.head });
  }

  return diffs;
}

function diffKey(diff: SnapshotDiff): string {
  return diff.kind === "field" ? `field:${diff.field}` : diff.kind;
}

function emptySummary(): ComparisonSummary {
  return {
    pass: true,
    runs: { settled: 0, active: 0 },
    runsWithDiffs: { settled: 0, active: 0 },
    diffsByKind: { settled: {}, active: {} },
  };
}

function addToSummary(summary: ComparisonSummary, result: RunComparison): void {
  const bucket = result.settled ? "settled" : "active";
  summary.runs[bucket]++;
  if (result.diffs.length === 0) return;
  summary.runsWithDiffs[bucket]++;
  for (const diff of result.diffs) {
    const key = diffKey(diff);
    summary.diffsByKind[bucket][key] = (summary.diffsByKind[bucket][key] ?? 0) + 1;
  }
  summary.pass = summary.runsWithDiffs.settled === 0;
}

type RunCursor = { createdAt: Date; id: string };

async function listRunIds(
  prisma: PrismaClient,
  options: { environmentId: string; from: Date; to: Date; limit: number; after?: RunCursor }
): Promise<{ runIds: string[]; next?: RunCursor }> {
  const after = options.after ?? { createdAt: options.from, id: "" };
  const rows = await prisma.$queryRaw<Array<{ id: string; createdAt: Date }>>`
    SELECT id, "createdAt" FROM "TaskRun"
    WHERE "runtimeEnvironmentId" = ${options.environmentId}
      AND "createdAt" >= ${options.from} AND "createdAt" < ${options.to}
      AND ("createdAt", id) > (${after.createdAt}, ${after.id})
    ORDER BY "createdAt", id
    LIMIT ${options.limit}`;
  const last = rows[rows.length - 1];
  return {
    runIds: rows.map((r) => r.id),
    next:
      rows.length === options.limit && last
        ? { createdAt: last.createdAt, id: last.id }
        : undefined,
  };
}

async function readPostgresSnapshots(
  prisma: PrismaClient,
  runIds: string[]
): Promise<Map<string, PostgresSnapshotRow[]>> {
  const rows = await prisma.$queryRaw<PostgresSnapshotRow[]>`
    SELECT id, "runId", "createdAt", "executionStatus"::text AS "executionStatus", description,
      "runStatus"::text AS "runStatus", "attemptNumber", "previousSnapshotId", "batchId",
      "environmentId", "environmentType"::text AS "environmentType", "projectId", "organizationId",
      "checkpointId", "workerId", "runnerId", metadata, error, "isValid"
    FROM "TaskRunExecutionSnapshot"
    WHERE "runId" = ANY(${runIds})
    ORDER BY "runId", "createdAt", id`;
  const byRun = new Map<string, PostgresSnapshotRow[]>();
  for (const row of rows) {
    const list = byRun.get(row.runId) ?? [];
    list.push(row);
    byRun.set(row.runId, list);
  }
  return byRun;
}

async function readRedisRunState(redis: RedisClient, runId: string): Promise<RedisRunState> {
  const k = snapshotKeys(runId);
  const [entries, validIds, head, prepared] = await Promise.all([
    redis.hgetall(k.e),
    redis.zrange(k.idx, 0, -1),
    redis.get(k.cur),
    redis.exists(preparedUnitKey(runId)),
  ]);
  return { entries, validIds, head, prepared: prepared === 1 };
}

type SkippedRuns = {
  postgres: number;
  redisPrimary: number;
  noSnapshots: number;
  unknown: number;
  expired: number;
};

function emptySkipped(): SkippedRuns {
  return { postgres: 0, redisPrimary: 0, noSnapshots: 0, unknown: 0, expired: 0 };
}

/**
 * The webapp's DEFAULT completed TTL. If the target environment overrides
 * RUN_ENGINE_SNAPSHOT_STORE_COMPLETED_TTL_MS, expired runs are misclassified.
 */
export const FINISHED_RUN_RETENTION_MS = 4 * 24 * 60 * 60 * 1000;

function isExpired(
  rows: PostgresSnapshotRow[],
  diffs: SnapshotDiff[],
  expiredBefore: Date
): boolean {
  const last = rows[rows.length - 1];
  return (
    diffs.length === 1 &&
    diffs[0].kind === "keyspace-missing" &&
    isTerminalEntry(entryFromSnapshotRow(last)) &&
    last.createdAt.getTime() < expiredBefore.getTime()
  );
}

/** Compares the runs born mirrored. Residency comes from the birth snapshot, never the live flag. */
export async function compareRuns(options: {
  prisma: PrismaClient;
  redis: RedisClient;
  runIds: string[];
  settledBefore: Date;
  maxCompared: number;
  expiredBefore: Date;
}): Promise<{ results: RunComparison[]; skipped: SkippedRuns }> {
  const skipped = emptySkipped();
  const snapshots = await readPostgresSnapshots(options.prisma, options.runIds);

  const mirrored: Array<{ runId: string; rows: PostgresSnapshotRow[] }> = [];
  for (const runId of options.runIds) {
    const rows = snapshots.get(runId);
    if (!rows || rows.length === 0) {
      skipped.noSnapshots++;
      continue;
    }
    let residency;
    try {
      residency = snapshotResidencyFromMetadata(rows[0].metadata);
    } catch {
      skipped.unknown++;
      continue;
    }
    if (residency === "postgres") skipped.postgres++;
    else if (residency === "redis-primary") skipped.redisPrimary++;
    else mirrored.push({ runId, rows });
  }

  // Compare in order until maxCompared runs count; an expired run is skipped without using the limit.
  const results: RunComparison[] = [];
  let next = 0;
  while (next < mirrored.length && results.length < options.maxCompared) {
    const chunk = mirrored.slice(next, next + (options.maxCompared - results.length));
    next += chunk.length;
    results.push(...(await compareChunk(chunk, options, skipped)));
  }
  return { results, skipped };
}

async function compareChunk(
  mirrored: Array<{ runId: string; rows: PostgresSnapshotRow[] }>,
  options: { prisma: PrismaClient; redis: RedisClient; settledBefore: Date; expiredBefore: Date },
  skipped: SkippedRuns
): Promise<RunComparison[]> {
  const first = await Promise.all(
    mirrored.map(async ({ runId, rows }) => ({
      runId,
      rows,
      diffs: compareRun(rows, await readRedisRunState(options.redis, runId)),
    }))
  );

  // Postgres was read before Redis, so a run that moved in between looks divergent. Read both
  // again, Postgres first, and judge settledness from the fresh rows.
  const retryIds = first.filter((r) => r.diffs.length > 0).map((r) => r.runId);
  const fresh =
    retryIds.length > 0 ? await readPostgresSnapshots(options.prisma, retryIds) : undefined;

  const results: RunComparison[] = [];
  for (const result of first) {
    let { rows, diffs } = result;
    if (diffs.length > 0) {
      rows = fresh?.get(result.runId) ?? rows;
      diffs = compareRun(rows, await readRedisRunState(options.redis, result.runId));
    }
    if (isExpired(rows, diffs, options.expiredBefore)) {
      skipped.expired++;
      continue;
    }
    const latest = Math.max(...rows.map((r) => r.createdAt.getTime()));
    results.push({ runId: result.runId, settled: latest < options.settledBefore.getTime(), diffs });
  }
  return results;
}

function parseCli() {
  return parseArgs({
    options: {
      "redis-url": { type: "string" },
      "redis-cluster": { type: "boolean", default: false },
      "control-plane-url": { type: "string" },
      "run-db-url": { type: "string", multiple: true, default: [] },
      org: { type: "string", multiple: true, default: [] },
      env: { type: "string", multiple: true, default: [] },
      from: { type: "string" },
      to: { type: "string" },
      "settle-minutes": { type: "string", default: "10" },
      "batch-size": { type: "string", default: "500" },
      "pause-ms": { type: "string", default: "100" },
      limit: { type: "string" },
      out: { type: "string" },
      check: { type: "boolean", default: false },
    },
  }).values;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function connectRedis(url: string, cluster: boolean): RedisClient {
  const parsed = new URL(url);
  const tls = parsed.protocol === "rediss:" ? { servername: parsed.hostname } : undefined;
  const redisOptions = {
    username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
    password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    tls,
  };
  if (!cluster) {
    return createRedisClient({
      host: parsed.hostname,
      port: Number(parsed.port || 6379),
      ...redisOptions,
    });
  }
  return createRedisClusterClient({
    nodes: [{ host: parsed.hostname, port: Number(parsed.port || 6379) }],
    clusterOptions: {
      scaleReads: "slave",
      ...(tls && {
        dnsLookup: (address: string, callback: (err: Error | null, address: string) => void) =>
          callback(null, address),
      }),
    },
    redisOptions,
  });
}

async function resolveEnvironments(controlPlane: PrismaClient, orgs: string[]): Promise<string[]> {
  if (orgs.length === 0) return [];
  const rows = await controlPlane.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "RuntimeEnvironment" WHERE "organizationId" = ANY(${orgs})`;
  return rows.map((r) => r.id);
}

/** Host and database only, so credentials never reach the output. */
function describeUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname}`;
}

async function checkConnections(
  redis: RedisClient,
  cluster: boolean,
  dbs: Array<{ url: string; db: PrismaClient }>
): Promise<boolean> {
  let ok = true;
  for (const { url, db } of dbs) {
    try {
      const [row] = await db.$queryRaw<Array<Record<string, unknown>>>`
        SELECT current_database() AS database, pg_is_in_recovery() AS "isReplica",
          to_regclass('"TaskRun"') IS NOT NULL AS "hasTaskRun",
          to_regclass('"TaskRunExecutionSnapshot"') IS NOT NULL AS "hasSnapshots",
          to_regclass('"RuntimeEnvironment"') IS NOT NULL AS "hasEnvironments"`;
      console.log(JSON.stringify({ postgres: describeUrl(url), ok: true, ...row }));
    } catch (error) {
      ok = false;
      console.log(JSON.stringify({ postgres: describeUrl(url), ok: false, error: String(error) }));
    }
  }
  try {
    const timeout = sleep(15_000).then(() => {
      throw new Error("timed out after 15s");
    });
    const ping = await Promise.race([redis.ping(), timeout]);
    const protocolMarker = await redis.get(protocolMarkerKey());
    let clusterInfo = {};
    if (cluster) {
      const info = String(await (redis as Cluster).cluster("INFO"));
      clusterInfo = {
        clusterState: /cluster_state:(\w+)/.exec(info)?.[1],
        masters: (redis as Cluster).nodes("master").length,
        replicas: (redis as Cluster).nodes("slave").length,
      };
    }
    console.log(JSON.stringify({ redis: "ok", ping, protocolMarker, ...clusterInfo }));
  } catch (error) {
    ok = false;
    console.log(JSON.stringify({ redis: "failed", error: String(error) }));
  }
  return ok;
}

async function main() {
  const values = parseCli();
  const redisUrl = values["redis-url"] || fail("--redis-url is required (or its env var is empty)");
  const controlPlaneUrl = values["control-plane-url"];
  if (values.org.length > 0 && !controlPlaneUrl) fail("--org needs --control-plane-url");
  const runDbUrls = values["run-db-url"].length > 0 ? values["run-db-url"] : [controlPlaneUrl];
  if (values["run-db-url"].some((u) => !u) || values["control-plane-url"] === "") {
    fail("a database URL is empty: check the env vars are exported in this shell");
  }
  if (runDbUrls.some((u) => !u)) fail("pass --run-db-url or --control-plane-url");

  if (values.check) {
    const redis = connectRedis(redisUrl, values["redis-cluster"]);
    const urls = [...new Set([controlPlaneUrl, ...runDbUrls].filter((u): u is string => !!u))];
    const dbs = urls.map((url) => ({
      url,
      db: new PrismaClient({ datasources: { db: { url } } }),
    }));
    try {
      process.exitCode = (await checkConnections(redis, values["redis-cluster"], dbs)) ? 0 : 1;
    } finally {
      redis.disconnect();
      await Promise.all(dbs.map(({ db }) => db.$disconnect()));
    }
    return;
  }

  const from = new Date(values.from ?? fail("--from is required"));
  const to = new Date(values.to ?? fail("--to is required"));
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) fail("bad --from/--to");
  const settleMs = Number(values["settle-minutes"]) * 60_000;
  if (!Number.isFinite(settleMs) || settleMs < 0) fail("bad --settle-minutes");
  const batchSize = Number(values["batch-size"]);
  if (!Number.isInteger(batchSize) || batchSize < 1) fail("bad --batch-size");
  const pauseMs = Number(values["pause-ms"]);
  if (!Number.isFinite(pauseMs) || pauseMs < 0) fail("bad --pause-ms");
  const limit = values.limit === undefined ? Infinity : Number(values.limit);
  if (!(limit > 0) || (limit !== Infinity && !Number.isInteger(limit))) fail("bad --limit");
  const outPath = values.out ?? `snapshot-compare-${new Date().toISOString()}.jsonl`;

  const redis = connectRedis(redisUrl, values["redis-cluster"]);
  const controlPlane = controlPlaneUrl
    ? new PrismaClient({ datasources: { db: { url: controlPlaneUrl } } })
    : undefined;
  const runDbs = runDbUrls.map((url) => new PrismaClient({ datasources: { db: { url: url! } } }));
  const out = createWriteStream(outPath);

  try {
    const environments = [
      ...new Set([...values.env, ...(await resolveEnvironments(controlPlane!, values.org))]),
    ];
    if (environments.length === 0) fail("no environments: pass --org or --env");

    const settledBefore = new Date(Date.now() - settleMs);
    const seen = new Set<string>();
    const summary = emptySummary();
    const skipped = emptySkipped();
    const expiredBefore = new Date(Date.now() - FINISHED_RUN_RETENTION_MS);

    listing: for (const db of runDbs) {
      for (const environmentId of environments) {
        let after: RunCursor | undefined;
        do {
          const remaining = limit - (summary.runs.settled + summary.runs.active);
          if (remaining <= 0) break listing;
          const page = await listRunIds(db, { environmentId, from, to, limit: batchSize, after });
          after = page.next;
          const runIds = page.runIds.filter((id) => !seen.has(id));
          runIds.forEach((id) => seen.add(id));
          if (runIds.length === 0) continue;

          const batch = await compareRuns({
            prisma: db,
            redis,
            runIds,
            settledBefore,
            maxCompared: remaining,
            expiredBefore,
          });
          for (const key of Object.keys(skipped) as Array<keyof SkippedRuns>) {
            skipped[key] += batch.skipped[key];
          }
          for (const result of batch.results) {
            addToSummary(summary, result);
            if (result.diffs.length > 0) out.write(`${JSON.stringify(result)}\n`);
          }
          const compared = summary.runs.settled + summary.runs.active;
          console.error(`${environmentId}: ${seen.size} runs listed, ${compared} compared`);
          await sleep(pauseMs);
        } while (after);
      }
    }

    out.end();
    await finished(out);

    console.log(
      JSON.stringify(
        {
          window: { from, to },
          settledBefore,
          limit: Number.isFinite(limit) ? limit : null,
          limitReached: summary.runs.settled + summary.runs.active >= limit,
          skipped,
          ...summary,
          diffs: outPath,
        },
        null,
        2
      )
    );
    process.exitCode = summary.pass ? 0 : 1;
  } finally {
    if (!out.writableEnded) out.end();
    await redis.quit();
    await Promise.all([controlPlane?.$disconnect(), ...runDbs.map((db) => db.$disconnect())]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
