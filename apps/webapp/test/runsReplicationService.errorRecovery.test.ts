import { ClickHouse } from "@internal/clickhouse";
import { containerTest } from "@internal/testcontainers";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { RunsReplicationService } from "~/services/runsReplicationService.server";

vi.setConfig({ testTimeout: 120_000 });

// These tests force a replication-stream disconnect (the same shape Postgres
// reports during an RDS failover) and verify each error-recovery strategy
// behaves correctly:
//   - "reconnect" (default) auto-resubscribes and resumes from the last LSN
//   - "exit" exits the process so a supervisor restarts it
//   - "log" keeps historical behaviour (silent death of the stream)
describe("RunsReplicationService error recovery", () => {
  containerTest(
    "reconnect strategy auto-recovers after the replication backend is killed",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
        compression: { request: true },
        logLevel: "warn",
      });

      const service = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
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
        logLevel: "warn",
        // Tight backoff so the test doesn't wait minutes.
        errorRecovery: {
          type: "reconnect",
          initialDelayMs: 200,
          maxDelayMs: 1000,
        },
      });

      try {
        await service.start();
        const seed = await seedOrgProjectEnv(prisma);

        // Insert a row pre-failure and verify it replicates.
        const runA = await createTaskRun(prisma, seed, "run_pre_failover");
        await waitForRunIdsInClickHouse(clickhouse, [runA.id]);

        // Kill the WAL sender backend — same shape as the RDS failover that
        // dropped both replication clients on test cloud.
        await killReplicationBackend(prisma, "runs-replication");

        // Insert a row after the kill. With the reconnect strategy the
        // service should automatically resubscribe and pick this up.
        const runB = await createTaskRun(prisma, seed, "run_post_failover");
        await waitForRunIdsInClickHouse(clickhouse, [runA.id, runB.id], { timeoutMs: 30_000 });
      } finally {
        await service.shutdown();
      }
    }
  );

  containerTest(
    "exit strategy calls process.exit after the replication backend is killed",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      // Stub process.exit so the test process itself doesn't terminate.
      // mockImplementation returns never; cast to satisfy the signature.
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation(((code?: number) => undefined as never) as typeof process.exit);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
        compression: { request: true },
        logLevel: "warn",
      });

      const service = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
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
        logLevel: "warn",
        errorRecovery: {
          type: "exit",
          // Short delay so the test stays quick; the flush window doesn't
          // matter here because we're stubbing the actual exit call.
          exitDelayMs: 100,
          exitCode: 1,
        },
      });

      try {
        await service.start();
        const seed = await seedOrgProjectEnv(prisma);

        // Sanity check: replication is alive before the kill.
        const runA = await createTaskRun(prisma, seed, "run_pre_exit");
        await waitForRunIdsInClickHouse(clickhouse, [runA.id]);

        await killReplicationBackend(prisma, "runs-replication");

        // Wait long enough for the error event to fire and the exit timer
        // to elapse, plus slack.
        await setTimeout(2000);

        expect(exitSpy).toHaveBeenCalledWith(1);
      } finally {
        exitSpy.mockRestore();
        await service.shutdown();
      }
    }
  );

  containerTest(
    "log strategy leaves replication permanently stopped",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
        compression: { request: true },
        logLevel: "warn",
      });

      const service = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
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
        logLevel: "warn",
        errorRecovery: { type: "log" },
      });

      try {
        await service.start();
        const seed = await seedOrgProjectEnv(prisma);

        const runA = await createTaskRun(prisma, seed, "run_pre_log");
        await waitForRunIdsInClickHouse(clickhouse, [runA.id]);

        await killReplicationBackend(prisma, "runs-replication");

        // Give the service time to attempt (and not) any recovery.
        await setTimeout(2000);

        // Insert a row after the kill — under the log strategy nothing
        // brings the stream back, so this should not appear in ClickHouse.
        const runB = await createTaskRun(prisma, seed, "run_post_log");
        await setTimeout(3000);

        const ids = await readReplicatedRunIds(clickhouse);
        expect(ids).toContain(runA.id);
        expect(ids).not.toContain(runB.id);
      } finally {
        await service.shutdown();
      }
    }
  );
});

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------

type SeedRefs = {
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
};

async function seedOrgProjectEnv(prisma: any): Promise<SeedRefs> {
  const organization = await prisma.organization.create({
    data: { title: "test", slug: "test" },
  });
  const project = await prisma.project.create({
    data: {
      name: "test",
      slug: "test",
      organizationId: organization.id,
      externalRef: "test",
    },
  });
  const runtimeEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "test",
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: "test",
      pkApiKey: "test",
      shortcode: "test",
    },
  });
  return {
    organizationId: organization.id,
    projectId: project.id,
    runtimeEnvironmentId: runtimeEnvironment.id,
  };
}

async function createTaskRun(prisma: any, seed: SeedRefs, friendlyId: string) {
  return prisma.taskRun.create({
    data: {
      friendlyId,
      taskIdentifier: "my-task",
      payload: JSON.stringify({ foo: "bar" }),
      traceId: friendlyId,
      spanId: friendlyId,
      queue: "test",
      runtimeEnvironmentId: seed.runtimeEnvironmentId,
      projectId: seed.projectId,
      organizationId: seed.organizationId,
      environmentType: "DEVELOPMENT",
      engine: "V2",
    },
  });
}

// Kills any active WAL-sender backends whose application_name matches the
// service. This mirrors the failover-style disconnect that surfaced the bug:
// the WAL stream connection drops and the LogicalReplicationClient errors.
async function killReplicationBackend(prisma: any, applicationName: string) {
  // Wait briefly for the WAL sender to appear in pg_stat_replication after
  // subscribe() completes — there's a small async gap between
  // replicationStart firing and the row being visible to other sessions.
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await prisma.$queryRawUnsafe<{ pid: number }[]>(
      `SELECT pid FROM pg_stat_replication WHERE application_name = $1`,
      applicationName
    );
    if (rows.length > 0) {
      for (const { pid } of rows) {
        await prisma.$executeRawUnsafe(`SELECT pg_terminate_backend(${pid})`);
      }
      return;
    }
    await setTimeout(100);
  }
  throw new Error(
    `No active replication backend found for application_name=${applicationName} after 2s`
  );
}

async function readReplicatedRunIds(clickhouse: ClickHouse): Promise<string[]> {
  const queryRuns = clickhouse.reader.query({
    name: "runs-replication",
    query: "SELECT run_id FROM trigger_dev.task_runs_v2",
    schema: z.object({ run_id: z.string() }),
  });
  const [queryError, result] = await queryRuns({});
  if (queryError) throw queryError;
  return (result ?? []).map((row) => row.run_id);
}

async function waitForRunIdsInClickHouse(
  clickhouse: ClickHouse,
  expectedIds: string[],
  options: { timeoutMs?: number; pollIntervalMs?: number } = {}
) {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const pollIntervalMs = options.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let lastIds: string[] = [];
  while (Date.now() < deadline) {
    lastIds = await readReplicatedRunIds(clickhouse);
    if (expectedIds.every((id) => lastIds.includes(id))) return;
    await setTimeout(pollIntervalMs);
  }
  throw new Error(
    `Timed out waiting for run ids ${JSON.stringify(expectedIds)} to land in ClickHouse. ` +
      `Last seen: ${JSON.stringify(lastIds)}`
  );
}
