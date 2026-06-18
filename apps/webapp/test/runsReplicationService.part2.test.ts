import { ClickHouse, getTaskRunField, getPayloadField } from "@internal/clickhouse";
import { replicationContainerTest } from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { detectBadJsonStrings } from "~/utils/detectBadJsonStrings";
import { TestReplicationClickhouseFactory } from "./utils/testReplicationClickhouseFactory";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsReplicationService (part 2/7)", () => {
  replicationContainerTest(
    "should handover leadership to a second service, and the second service should be able to extend the leader lock",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-shutdown-handover",
        logLevel: "warn",
      });

      // Service A
      const runsReplicationServiceA = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-shutdown-handover",
        slotName: "task_runs_to_clickhouse_v1",
        publicationName: "task_runs_to_clickhouse_v1_publication",
        redisOptions,
        maxFlushConcurrency: 1,
        flushIntervalMs: 100,
        flushBatchSize: 1,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        leaderLockAcquireAdditionalTimeMs: 10_000,
        ackIntervalSeconds: 5,
        logger: new Logger("runs-replication-shutdown-handover-a", "warn"),
      });

      await runsReplicationServiceA.start();

      // Service A
      const runsReplicationServiceB = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-shutdown-handover",
        slotName: "task_runs_to_clickhouse_v1",
        publicationName: "task_runs_to_clickhouse_v1_publication",
        redisOptions,
        maxFlushConcurrency: 1,
        flushIntervalMs: 100,
        flushBatchSize: 1,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        leaderLockAcquireAdditionalTimeMs: 10_000,
        ackIntervalSeconds: 5,
        logger: new Logger("runs-replication-shutdown-handover-b", "warn"),
      });

      // Now we need to initiate starting the second service, and after 6 seconds, we need to shutdown the first service
      await Promise.all([
        setTimeout(6000).then(() => runsReplicationServiceA.stop()),
        runsReplicationServiceB.start(),
      ]);

      const organization = await prisma.organization.create({
        data: {
          title: "test",
          slug: "test",
        },
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

      // Now we insert a row into the table
      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await setTimeout(10_000);

      // Check that the row was replicated to clickhouse
      const queryRuns = clickhouse.reader.query({
        name: "runs-replication",
        query: "SELECT * FROM trigger_dev.task_runs_v2",
        schema: z.any(),
      });

      const [queryError, result] = await queryRuns({});

      expect(queryError).toBeNull();
      expect(result?.length).toBe(1);
      expect(result?.[0]).toEqual(
        expect.objectContaining({
          run_id: taskRun.id,
          friendly_id: taskRun.friendlyId,
          task_identifier: taskRun.taskIdentifier,
          environment_id: runtimeEnvironment.id,
          project_id: project.id,
          organization_id: organization.id,
          environment_type: "DEVELOPMENT",
          engine: "V2",
        })
      );

      await runsReplicationServiceB.stop();
    }
  );

  replicationContainerTest(
    "should replicate all 1,000 TaskRuns inserted in bulk to ClickHouse",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-stress-bulk-insert",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-stress-bulk-insert",
        slotName: "task_runs_to_clickhouse_v1",
        publicationName: "task_runs_to_clickhouse_v1_publication",
        redisOptions,
        maxFlushConcurrency: 10,
        flushIntervalMs: 100,
        flushBatchSize: 50,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        ackIntervalSeconds: 5,
        logLevel: "warn",
      });

      await runsReplicationService.start();

      const organization = await prisma.organization.create({
        data: {
          title: "test-stress-bulk-insert",
          slug: "test-stress-bulk-insert",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-stress-bulk-insert",
          slug: "test-stress-bulk-insert",
          organizationId: organization.id,
          externalRef: "test-stress-bulk-insert",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-stress-bulk-insert",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test-stress-bulk-insert",
          pkApiKey: "test-stress-bulk-insert",
          shortcode: "test-stress-bulk-insert",
        },
      });

      // Prepare 1,000 unique TaskRuns
      const now = Date.now();
      const runsData = Array.from({ length: 1000 }, (_, i) => ({
        friendlyId: `run_bulk_${now}_${i}`,
        taskIdentifier: `my-task-bulk`,
        payload: JSON.stringify({ bulk: i }),
        payloadType: "application/json",
        traceId: `bulk-${i}`,
        spanId: `bulk-${i}`,
        queue: "test-stress-bulk-insert",
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        environmentType: "DEVELOPMENT" as const,
        engine: "V2" as const,
        status: "PENDING" as const,
        attemptNumber: 1,
        createdAt: new Date(now + i),
        updatedAt: new Date(now + i),
      }));

      // Bulk insert
      const created = await prisma.taskRun.createMany({ data: runsData });
      expect(created.count).toBe(1000);

      // Wait for replication
      await setTimeout(5000);

      // Query ClickHouse for all runs using FINAL
      const queryRuns = clickhouse.reader.query({
        name: "runs-replication-stress-bulk-insert",
        query: `SELECT run_id, friendly_id, trace_id, task_identifier FROM trigger_dev.task_runs_v2 FINAL`,
        schema: z.any(),
      });

      const [queryError, result] = await queryRuns({});
      expect(queryError).toBeNull();
      expect(result?.length).toBe(1000);

      // Check a few random runs for correctness
      for (let i = 0; i < 10; i++) {
        const idx = Math.floor(Math.random() * 1000);
        const expected = runsData[idx];
        const found = result?.find((r: any) => r.friendly_id === expected.friendlyId);
        expect(found).toBeDefined();
        expect(found).toEqual(
          expect.objectContaining({
            friendly_id: expected.friendlyId,
            trace_id: expected.traceId,
            task_identifier: expected.taskIdentifier,
          })
        );
      }

      await runsReplicationService.stop();
    }
  );

  replicationContainerTest(
    "should replicate all 1,000 TaskRuns inserted in bulk to ClickHouse with updates",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-stress-bulk-insert",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-stress-bulk-insert",
        slotName: "task_runs_to_clickhouse_v1",
        publicationName: "task_runs_to_clickhouse_v1_publication",
        redisOptions,
        maxFlushConcurrency: 10,
        flushIntervalMs: 100,
        flushBatchSize: 50,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        ackIntervalSeconds: 5,
        logLevel: "warn",
      });

      await runsReplicationService.start();

      const organization = await prisma.organization.create({
        data: {
          title: "test-stress-bulk-insert",
          slug: "test-stress-bulk-insert",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-stress-bulk-insert",
          slug: "test-stress-bulk-insert",
          organizationId: organization.id,
          externalRef: "test-stress-bulk-insert",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-stress-bulk-insert",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test-stress-bulk-insert",
          pkApiKey: "test-stress-bulk-insert",
          shortcode: "test-stress-bulk-insert",
        },
      });

      // Prepare 1,000 unique TaskRuns
      const now = Date.now();
      const runsData = Array.from({ length: 1000 }, (_, i) => ({
        friendlyId: `run_bulk_${now}_${i}`,
        taskIdentifier: `my-task-bulk`,
        payload: JSON.stringify({ bulk: i }),
        payloadType: "application/json",
        traceId: `bulk-${i}`,
        spanId: `bulk-${i}`,
        queue: "test-stress-bulk-insert",
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        environmentType: "DEVELOPMENT" as const,
        engine: "V2" as const,
        status: "PENDING" as const,
        attemptNumber: 1,
        createdAt: new Date(now + i),
        updatedAt: new Date(now + i),
      }));

      // Bulk insert
      const created = await prisma.taskRun.createMany({ data: runsData });
      expect(created.count).toBe(1000);

      // Update all the runs
      await prisma.taskRun.updateMany({
        data: { status: "COMPLETED_SUCCESSFULLY" },
      });

      // Wait for replication
      await setTimeout(5000);

      // Query ClickHouse for all runs using FINAL
      const queryRuns = clickhouse.reader.query({
        name: "runs-replication-stress-bulk-insert",
        query: `SELECT * FROM trigger_dev.task_runs_v2 FINAL`,
        schema: z.any(),
      });

      const [queryError, result] = await queryRuns({});
      expect(queryError).toBeNull();
      expect(result?.length).toBe(1000);

      // Check a few random runs for correctness
      for (let i = 0; i < 10; i++) {
        const idx = Math.floor(Math.random() * 1000);
        const expected = runsData[idx];
        const found = result?.find((r: any) => r.friendly_id === expected.friendlyId);
        expect(found).toBeDefined();
        expect(found).toEqual(
          expect.objectContaining({
            friendly_id: expected.friendlyId,
            trace_id: expected.traceId,
            task_identifier: expected.taskIdentifier,
            status: "COMPLETED_SUCCESSFULLY",
          })
        );
      }

      await runsReplicationService.stop();
    }
  );
});
