import { ClickHouse } from "@internal/clickhouse";
import { RedisOptions } from "@internal/redis";
import { PrismaClient } from "~/db.server";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { TestReplicationClickhouseFactory } from "./testReplicationClickhouseFactory";
import { afterEach } from "vitest";

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
  // task_run_v2 is co-published with TaskRun; it needs FULL identity too so
  // UPDATE/DELETE WAL events carry the old row (the delete transform reads
  // organizationId/environmentType off it). Mirrors the TaskRun line above.
  await prisma.$executeRawUnsafe(`ALTER TABLE public."task_run_v2" REPLICA IDENTITY FULL;`);

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
