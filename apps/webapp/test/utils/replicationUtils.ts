import { ClickHouse } from "@internal/clickhouse";
import type { RedisOptions } from "@internal/redis";
import type { PrismaClient } from "~/db.server";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { TestReplicationClickhouseFactory } from "./testReplicationClickhouseFactory";
import { afterEach, expect } from "vitest";
import { setTimeout } from "node:timers/promises";

// Keepalives with shouldRespond every 1s instead of 30s, on this connection's walsender only.
export function withShortWalSenderTimeout(pgConnectionUrl: string) {
  const url = new URL(pgConnectionUrl);
  url.searchParams.set("options", "-c wal_sender_timeout=2s");
  return url.toString();
}

// Writes WAL that only keepalives report, then asserts flush_lsn reaches it and never falls back.
export async function expectFlushLsnHoldsPastIdleWal(prisma: PrismaClient, slotName: string) {
  const [{ lsn: target }] = await prisma.$queryRaw<{ lsn: string }[]>`
    SELECT pg_logical_emit_message(false, 'replication-ack-test', 'idle')::text AS lsn`;

  const flushAhead = async () => {
    const rows = await prisma.$queryRaw<{ ahead: number }[]>`
      SELECT (r.flush_lsn - ${target}::pg_lsn)::float8 AS ahead
      FROM pg_stat_replication r
      JOIN pg_replication_slots s ON s.active_pid = r.pid
      WHERE s.slot_name = ${slotName}`;
    return rows[0]?.ahead ?? null;
  };

  const deadline = performance.now() + 15_000;
  let ahead = await flushAhead();
  while ((ahead === null || ahead < 0) && performance.now() < deadline) {
    await setTimeout(50);
    ahead = await flushAhead();
  }
  expect(ahead, `flush_lsn never reached keepalive position ${target}`).toBeGreaterThanOrEqual(0);

  const samples: Array<number | null> = [];
  const observeUntil = performance.now() + 3_000;
  while (performance.now() < observeUntil) {
    samples.push(await flushAhead());
    await setTimeout(50);
  }
  const regressed = samples.filter((s) => s === null || s < 0);
  expect(regressed, `flush_lsn moved back below ${target}`).toEqual([]);
}

export async function setupClickhouseReplication({
  prisma,
  databaseUrl,
  clickhouseUrl,
  redisOptions,
}: {
  prisma: PrismaClient;
  databaseUrl: string;
  clickhouseUrl: string;
  redisOptions: RedisOptions;
}) {
  await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

  const clickhouse = new ClickHouse({
    url: clickhouseUrl,
    name: "runs-replication",
    compression: {
      request: true,
    },
  });

  const runsReplicationService = new RunsReplicationService({
    clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
    pgConnectionUrl: databaseUrl,
    serviceName: "runs-replication",
    slotName: "task_runs_to_clickhouse_v1",
    publicationName: "task_runs_to_clickhouse_v1_publication",
    redisOptions,
    maxFlushConcurrency: 1,
    flushIntervalMs: 100,
    flushBatchSize: 1,
    leaderLockTimeoutMs: 5000,
    leaderLockExtendIntervalMs: 1000,
    ackIntervalSeconds: 5,
  });

  await runsReplicationService.start();

  // Runs after each test in the current context
  afterEach(async () => {
    // Clean up resources here
    await runsReplicationService.stop();
  });

  return {
    clickhouse,
  };
}
