import { ClickHouse } from "@internal/clickhouse";
import { containerTest } from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { TaskRunStatus } from "~/database-types";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { createInMemoryTracing } from "./utils/tracing";
import superjson from "superjson";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsReplicationService (part 2/2)", () => {
  containerTest(
    "should handover leadership to a second service, and the second service should be able to extend the leader lock",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-shutdown-handover",
      });

      // Service A
      const runsReplicationServiceA = new RunsReplicationService({
        clickhouse,
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
        logger: new Logger("runs-replication-shutdown-handover-a", "debug"),
      });

      await runsReplicationServiceA.start();

      // Service A
      const runsReplicationServiceB = new RunsReplicationService({
        clickhouse,
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
        logger: new Logger("runs-replication-shutdown-handover-b", "debug"),
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

  containerTest(
    "should replicate all 1,000 TaskRuns inserted in bulk to ClickHouse",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-stress-bulk-insert",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouse,
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
        logger: new Logger("runs-replication-stress-bulk-insert", "info"),
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

  containerTest(
    "should replicate all 1,000 TaskRuns inserted in bulk to ClickHouse with updates",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-stress-bulk-insert",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouse,
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
        logger: new Logger("runs-replication-stress-bulk-insert", "info"),
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

  containerTest(
    "should replicate all events in a single transaction (insert, update)",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-multi-event-tx",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-multi-event-tx",
        slotName: "task_runs_to_clickhouse_v1",
        publicationName: "task_runs_to_clickhouse_v1_publication",
        redisOptions,
        maxFlushConcurrency: 1,
        flushIntervalMs: 100,
        flushBatchSize: 10,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        ackIntervalSeconds: 5,
      });

      await runsReplicationService.start();

      const organization = await prisma.organization.create({
        data: {
          title: "test-multi-event-tx",
          slug: "test-multi-event-tx",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-multi-event-tx",
          slug: "test-multi-event-tx",
          organizationId: organization.id,
          externalRef: "test-multi-event-tx",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-multi-event-tx",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test-multi-event-tx",
          pkApiKey: "test-multi-event-tx",
          shortcode: "test-multi-event-tx",
        },
      });

      // Start a transaction
      const [run1, run2] = await prisma.$transaction(async (tx) => {
        const run1 = await tx.taskRun.create({
          data: {
            friendlyId: `run_multi_event_1_${Date.now()}`,
            taskIdentifier: "my-task-multi-event-1",
            payload: JSON.stringify({ multi: 1 }),
            payloadType: "application/json",
            traceId: `multi-1-${Date.now()}`,
            spanId: `multi-1-${Date.now()}`,
            queue: "test-multi-event-tx",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
            status: "PENDING",
            attemptNumber: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
        const run2 = await tx.taskRun.create({
          data: {
            friendlyId: `run_multi_event_2_${Date.now()}`,
            taskIdentifier: "my-task-multi-event-2",
            payload: JSON.stringify({ multi: 2 }),
            payloadType: "application/json",
            traceId: `multi-2-${Date.now()}`,
            spanId: `multi-2-${Date.now()}`,
            queue: "test-multi-event-tx",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
            status: "PENDING",
            attemptNumber: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
        await tx.taskRun.update({
          where: { id: run1.id },
          data: { status: "COMPLETED_SUCCESSFULLY" },
        });

        return [run1, run2];
      });

      // Wait for replication
      await setTimeout(1000);

      // Query ClickHouse for both runs using FINAL
      const queryRuns = clickhouse.reader.query({
        name: "runs-replication-multi-event-tx",
        query: `SELECT * FROM trigger_dev.task_runs_v2 FINAL WHERE run_id IN ({run_id_1:String}, {run_id_2:String})`,
        schema: z.any(),
        params: z.object({ run_id_1: z.string(), run_id_2: z.string() }),
      });

      const [queryError, result] = await queryRuns({ run_id_1: run1.id, run_id_2: run2.id });
      expect(queryError).toBeNull();
      expect(result?.length).toBe(2);
      const run1Result = result?.find((r: any) => r.run_id === run1.id);
      const run2Result = result?.find((r: any) => r.run_id === run2.id);
      expect(run1Result).toBeDefined();
      expect(run1Result).toEqual(
        expect.objectContaining({ run_id: run1.id, status: "COMPLETED_SUCCESSFULLY" })
      );
      expect(run2Result).toBeDefined();
      expect(run2Result).toEqual(expect.objectContaining({ run_id: run2.id }));

      await runsReplicationService.stop();
    }
  );

  containerTest(
    "should be able to handle processing transactions for a long period of time",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-long-tx",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-long-tx",
        slotName: "task_runs_to_clickhouse_v1",
        publicationName: "task_runs_to_clickhouse_v1_publication",
        redisOptions,
        maxFlushConcurrency: 1,
        flushIntervalMs: 100,
        flushBatchSize: 10,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        ackIntervalSeconds: 5,
        logger: new Logger("runs-replication-long-tx", "info"),
      });

      await runsReplicationService.start();

      const organization = await prisma.organization.create({
        data: {
          title: "test-long-tx",
          slug: "test-long-tx",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-long-tx",
          slug: "test-long-tx",
          organizationId: organization.id,
          externalRef: "test-long-tx",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-long-tx",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test-long-tx",
          pkApiKey: "test-long-tx",
          shortcode: "test-long-tx",
        },
      });

      // Start an interval that will create a new run every 500ms for 4 minutes
      const interval = setInterval(async () => {
        await prisma.taskRun.create({
          data: {
            friendlyId: `run_long_tx_${Date.now()}`,
            taskIdentifier: "my-task-long-tx",
            payload: JSON.stringify({ long: 1 }),
            payloadType: "application/json",
            traceId: `long-${Date.now()}`,
            spanId: `long-${Date.now()}`,
            queue: "test-long-tx",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
            status: "PENDING",
            attemptNumber: 1,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        });
      }, 500);

      // Wait for 1 minute
      await setTimeout(1 * 60 * 1000);

      // Stop the interval
      clearInterval(interval);

      // Wait for replication
      await setTimeout(1000);

      // Query ClickHouse for all runs using FINAL
      const queryRuns = clickhouse.reader.query({
        name: "runs-replication-long-tx",
        query: `SELECT * FROM trigger_dev.task_runs_v2 FINAL`,
        schema: z.any(),
      });

      const [queryError, result] = await queryRuns({});
      expect(queryError).toBeNull();

      expect(result?.length).toBeGreaterThanOrEqual(50);

      await runsReplicationService.stop();
    },
    { timeout: 60_000 * 5 }
  );
});
