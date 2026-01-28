import { ClickHouse, getTaskRunField, getPayloadField } from "@internal/clickhouse";
import { containerTest } from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { detectBadJsonStrings } from "~/utils/detectBadJsonStrings";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsReplicationService (part 2/2)", () => {
  containerTest(
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
        logger: new Logger("runs-replication-shutdown-handover-a", "warn"),
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

  containerTest(
    "should replicate all 1,000 TaskRuns inserted in bulk to ClickHouse",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-stress-bulk-insert",
        logLevel: "warn",
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

  containerTest(
    "should replicate all 1,000 TaskRuns inserted in bulk to ClickHouse with updates",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-stress-bulk-insert",
        logLevel: "warn",
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

  containerTest(
    "should replicate all events in a single transaction (insert, update)",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-multi-event-tx",
        logLevel: "warn",
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
        logLevel: "warn",
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
        logLevel: "warn",
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
        logLevel: "warn",
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

  containerTest(
    "should insert TaskRuns even if there are incomplete Unicode escape sequences in the JSON",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-stress-bulk-insert",
        logLevel: "warn",
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

      // Prepare 9 unique TaskRuns
      const now = Date.now();
      const runsData = Array.from({ length: 9 }, (_, i) => ({
        friendlyId: `run_bulk_${now}_${i}`,
        taskIdentifier: `my-task-bulk`,
        payload: `{"title": "hello"}`,
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

      //add a run with incomplete Unicode escape sequences
      const badPayload = await readFile(`${__dirname}/bad-clickhouse-output.json`, "utf-8");
      const hasProblems = detectBadJsonStrings(badPayload);
      expect(hasProblems).toBe(true);

      runsData.push({
        friendlyId: `run_bulk_${now}_10`,
        taskIdentifier: `my-task-bulk`,
        payload: badPayload,
        payloadType: "application/json",
        traceId: `bulk-10`,
        spanId: `bulk-10`,
        queue: "test-stress-bulk-insert",
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        environmentType: "DEVELOPMENT" as const,
        engine: "V2" as const,
        status: "PENDING" as const,
        attemptNumber: 1,
        createdAt: new Date(now + 10),
        updatedAt: new Date(now + 10),
      });

      // Bulk insert
      const created = await prisma.taskRun.createMany({ data: runsData });
      expect(created.count).toBe(10);

      // Update the runs (not the 10th one)
      await prisma.taskRun.updateMany({
        where: {
          spanId: { not: "bulk-10" },
        },
        data: {
          status: "COMPLETED_SUCCESSFULLY",
          output: `{"foo":"bar"}`,
          outputType: "application/json",
        },
      });

      // Give the 10th one a bad payload
      await prisma.taskRun.updateMany({
        where: {
          spanId: "bulk-10",
        },
        data: {
          status: "COMPLETED_SUCCESSFULLY",
          output: badPayload,
          outputType: "application/json",
        },
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
      expect(result?.length).toBe(10);

      // Check a few random runs for correctness
      for (let i = 0; i < 9; i++) {
        const expected = runsData[i];
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
        expect(found?.output).toBeDefined();
      }

      // Check the run with the bad JSON
      const foundBad = result?.find((r: any) => r.span_id === "bulk-10");
      expect(foundBad).toBeDefined();
      expect(foundBad?.output).toStrictEqual({});

      await runsReplicationService.stop();
    }
  );

  containerTest(
    "should merge duplicate event+run.id combinations keeping the latest version",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public.\"TaskRun\" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-merge-batch",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-merge-batch",
        slotName: "task_runs_to_clickhouse_v1",
        publicationName: "task_runs_to_clickhouse_v1_publication",
        redisOptions,
        maxFlushConcurrency: 1,
        flushIntervalMs: 100,
        flushBatchSize: 10, // Higher batch size to test merging
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        ackIntervalSeconds: 5,
        logLevel: "warn",
      });

      // Listen to batchFlushed events to verify merging
      const batchFlushedEvents: Array<{
        flushId: string;
        taskRunInserts: any[];
        payloadInserts: any[];
      }> = [];

      runsReplicationService.events.on("batchFlushed", (event) => {
        batchFlushedEvents.push(event);
      });

      await runsReplicationService.start();

      const organization = await prisma.organization.create({
        data: {
          title: "test-merge-batch",
          slug: "test-merge-batch",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-merge-batch",
          slug: "test-merge-batch",
          organizationId: organization.id,
          externalRef: "test-merge-batch",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-merge-batch",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test-merge-batch",
          pkApiKey: "test-merge-batch",
          shortcode: "test-merge-batch",
        },
      });

      // Create a run and rapidly update it multiple times in a transaction
      // This should create multiple events for the same run that get merged
      const run = await prisma.taskRun.create({
        data: {
          friendlyId: `run_merge_${Date.now()}`,
          taskIdentifier: "my-task-merge",
          payload: JSON.stringify({ version: 1 }),
          payloadType: "application/json",
          traceId: `merge-${Date.now()}`,
          spanId: `merge-${Date.now()}`,
          queue: "test-merge-batch",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          status: "PENDING_VERSION",
        },
      });
      await prisma.taskRun.update({
        where: { id: run.id },
        data: { status: "DEQUEUED" },
      });
      await prisma.taskRun.update({
        where: { id: run.id },
        data: { status: "EXECUTING" },
      });
      await prisma.taskRun.update({
        where: { id: run.id },
        data: { status: "PAUSED" },
      });
      await prisma.taskRun.update({
        where: { id: run.id },
        data: { status: "EXECUTING" },
      });
      await prisma.taskRun.update({
        where: { id: run.id },
        data: { status: "COMPLETED_SUCCESSFULLY" },
      });

      await setTimeout(1000);

      expect(batchFlushedEvents?.[0].taskRunInserts).toHaveLength(2);
      // Use getTaskRunField for type-safe array access
      expect(getTaskRunField(batchFlushedEvents![0].taskRunInserts[0], "run_id")).toEqual(run.id);
      expect(getTaskRunField(batchFlushedEvents![0].taskRunInserts[0], "status")).toEqual(
        "PENDING_VERSION"
      );
      expect(getTaskRunField(batchFlushedEvents![0].taskRunInserts[1], "run_id")).toEqual(run.id);
      expect(getTaskRunField(batchFlushedEvents![0].taskRunInserts[1], "status")).toEqual(
        "COMPLETED_SUCCESSFULLY"
      );

      await runsReplicationService.stop();
    }
  );

  containerTest(
    "should sort batch inserts according to table schema ordering for optimal performance",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public.\"TaskRun\" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-sorting",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-sorting",
        slotName: "task_runs_to_clickhouse_v1",
        publicationName: "task_runs_to_clickhouse_v1_publication",
        redisOptions,
        maxFlushConcurrency: 1,
        flushIntervalMs: 100,
        flushBatchSize: 10,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        ackIntervalSeconds: 5,
        logLevel: "warn",
      });

      // Listen to batchFlushed events to verify sorting
      const batchFlushedEvents: Array<{
        flushId: string;
        taskRunInserts: any[];
        payloadInserts: any[];
      }> = [];

      runsReplicationService.events.on("batchFlushed", (event) => {
        batchFlushedEvents.push(event);
      });

      await runsReplicationService.start();

      // Create two organizations to test sorting by organization_id
      const org1 = await prisma.organization.create({
        data: { title: "org-z", slug: "org-z" },
      });

      const org2 = await prisma.organization.create({
        data: { title: "org-a", slug: "org-a" },
      });

      const project1 = await prisma.project.create({
        data: {
          name: "test-sorting-z",
          slug: "test-sorting-z",
          organizationId: org1.id,
          externalRef: "test-sorting-z",
        },
      });

      const project2 = await prisma.project.create({
        data: {
          name: "test-sorting-a",
          slug: "test-sorting-a",
          organizationId: org2.id,
          externalRef: "test-sorting-a",
        },
      });

      const env1 = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-sorting-z",
          type: "DEVELOPMENT",
          projectId: project1.id,
          organizationId: org1.id,
          apiKey: "test-sorting-z",
          pkApiKey: "test-sorting-z",
          shortcode: "test-sorting-z",
        },
      });

      const env2 = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-sorting-a",
          type: "DEVELOPMENT",
          projectId: project2.id,
          organizationId: org2.id,
          apiKey: "test-sorting-a",
          pkApiKey: "test-sorting-a",
          shortcode: "test-sorting-a",
        },
      });

      const now = Date.now();

      const run1 = await prisma.taskRun.create({
        data: {
          friendlyId: `run_sort_org_z_${now}`,
          taskIdentifier: "my-task-sort",
          payload: JSON.stringify({ org: "z" }),
          payloadType: "application/json",
          traceId: `sort-z-${now}`,
          spanId: `sort-z-${now}`,
          queue: "test-sorting",
          runtimeEnvironmentId: env1.id,
          projectId: project1.id,
          organizationId: org1.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          status: "PENDING",
          createdAt: new Date(now + 2000),
        },
      });
      await prisma.taskRun.update({
        where: { id: run1.id },
        data: { status: "DEQUEUED" },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: `run_sort_org_a_${now}`,
          taskIdentifier: "my-task-sort",
          payload: JSON.stringify({ org: "a" }),
          payloadType: "application/json",
          traceId: `sort-a-${now}`,
          spanId: `sort-a-${now}`,
          queue: "test-sorting",
          runtimeEnvironmentId: env2.id,
          projectId: project2.id,
          organizationId: org2.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          status: "PENDING",
          createdAt: new Date(now + 1000),
        },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: `run_sort_org_a_${now}_2`,
          taskIdentifier: "my-task-sort",
          payload: JSON.stringify({ org: "a" }),
          payloadType: "application/json",
          traceId: `sort-a-${now}`,
          spanId: `sort-a-${now}`,
          queue: "test-sorting",
          runtimeEnvironmentId: env2.id,
          projectId: project2.id,
          organizationId: org2.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          status: "PENDING",
          createdAt: new Date(now),
        },
      });

      await setTimeout(1000);

      expect(batchFlushedEvents[0]?.taskRunInserts.length).toBeGreaterThan(1);
      expect(batchFlushedEvents[0]?.payloadInserts.length).toBeGreaterThan(1);

      // Verify sorting order: organization_id, project_id, environment_id, created_at, run_id
      for (let i = 1; i < batchFlushedEvents[0]?.taskRunInserts.length; i++) {
        const prev = batchFlushedEvents[0]!.taskRunInserts[i - 1];
        const curr = batchFlushedEvents[0]!.taskRunInserts[i];

        const prevKey = [
          getTaskRunField(prev, "organization_id"),
          getTaskRunField(prev, "project_id"),
          getTaskRunField(prev, "environment_id"),
          getTaskRunField(prev, "created_at"),
          getTaskRunField(prev, "run_id"),
        ];
        const currKey = [
          getTaskRunField(curr, "organization_id"),
          getTaskRunField(curr, "project_id"),
          getTaskRunField(curr, "environment_id"),
          getTaskRunField(curr, "created_at"),
          getTaskRunField(curr, "run_id"),
        ];

        const keysAreEqual = prevKey.every((val, idx) => val === currKey[idx]);
        if (keysAreEqual) {
          // Also valid order
          continue;
        }

        // Compare tuples lexicographically
        let isCorrectOrder = false;
        for (let j = 0; j < prevKey.length; j++) {
          if (prevKey[j] < currKey[j]) {
            isCorrectOrder = true;
            break;
          }
          if (prevKey[j] > currKey[j]) {
            isCorrectOrder = false;
            break;
          }
          // If equal, continue to next field
        }

        expect(isCorrectOrder).toBeTruthy();
      }

      // Verify payloadInserts are also sorted by run_id
      for (let i = 1; i < batchFlushedEvents[0]?.payloadInserts.length; i++) {
        const prev = batchFlushedEvents[0]!.payloadInserts[i - 1];
        const curr = batchFlushedEvents[0]!.payloadInserts[i];
        expect(getPayloadField(prev, "run_id") <= getPayloadField(curr, "run_id")).toBeTruthy();
      }

      await runsReplicationService.stop();
    }
  );

  containerTest(
    "should exhaustively replicate all TaskRun columns to ClickHouse",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-exhaustive",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-exhaustive",
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
      });

      await runsReplicationService.start();

      const organization = await prisma.organization.create({
        data: {
          title: "test-exhaustive",
          slug: "test-exhaustive",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-exhaustive",
          slug: "test-exhaustive",
          organizationId: organization.id,
          externalRef: "test-exhaustive",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-exhaustive",
          type: "PRODUCTION",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test-exhaustive",
          pkApiKey: "test-exhaustive",
          shortcode: "test-exhaustive",
        },
      });

      // Create a batch for the batchId field
      const batch = await prisma.batchTaskRun.create({
        data: {
          friendlyId: "batch_exhaustive",
          runtimeEnvironmentId: runtimeEnvironment.id,
          status: "PENDING",
        },
      });

      // Create a root run for the rootTaskRunId field
      const rootRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_root_exhaustive",
          taskIdentifier: "root-task",
          payload: JSON.stringify({ root: true }),
          traceId: "root-trace-id",
          spanId: "root-span-id",
          queue: "root-queue",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "PRODUCTION",
          engine: "V2",
        },
      });

      // Create a parent run for the parentTaskRunId field
      const parentRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_parent_exhaustive",
          taskIdentifier: "parent-task",
          payload: JSON.stringify({ parent: true }),
          traceId: "parent-trace-id",
          spanId: "parent-span-id",
          queue: "parent-queue",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "PRODUCTION",
          engine: "V2",
          rootTaskRunId: rootRun.id,
          depth: 1,
        },
      });

      // Set up all the dates we'll use
      const now = new Date();
      const createdAt = new Date(now.getTime() - 10000);
      const updatedAt = new Date(now.getTime() - 5000);
      const startedAt = new Date(now.getTime() - 8000);
      const executedAt = new Date(now.getTime() - 7500);
      const completedAt = new Date(now.getTime() - 6000);
      const delayUntil = new Date(now.getTime() - 9000);
      const queuedAt = new Date(now.getTime() - 9500);
      const expiredAt = null; // Not expired

      // Create the main task run with ALL fields populated
      const taskRun = await prisma.taskRun.create({
        data: {
          // Core identifiers
          friendlyId: "run_exhaustive_test",
          taskIdentifier: "exhaustive-task",

          // Environment/project/org
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "PRODUCTION",

          // Engine and execution
          engine: "V2",
          status: "COMPLETED_SUCCESSFULLY",
          attemptNumber: 3,
          queue: "exhaustive-queue",
          workerQueue: "exhaustive-worker-queue",

          // Relationships
          // Note: scheduleId is not set to test empty string handling
          batchId: batch.id,
          rootTaskRunId: rootRun.id,
          parentTaskRunId: parentRun.id,
          depth: 2,

          // Timestamps
          createdAt,
          updatedAt,
          startedAt,
          executedAt,
          completedAt,
          delayUntil,
          queuedAt,
          expiredAt,

          // Payload and output
          payload: JSON.stringify({ input: "test-payload" }),
          payloadType: "application/json",
          output: JSON.stringify({ result: "test-output" }),
          outputType: "application/json",
          error: { message: "test error", name: "TestError" },

          // Tracing
          traceId: "exhaustive-trace-id-12345",
          spanId: "exhaustive-span-id-67890",

          // Versioning
          taskVersion: "1.2.3",
          sdkVersion: "3.0.0",
          cliVersion: "2.5.1",

          // Execution settings
          machinePreset: "large-1x",
          idempotencyKey: "exhaustive-idempotency-key-hashed",
          idempotencyKeyOptions: {
            key: "exhaustive-idempotency-key",
            scope: "run",
          },
          ttl: "1h",
          isTest: true,
          concurrencyKey: "exhaustive-concurrency-key",
          maxDurationInSeconds: 3600,

          // Tags and bulk actions
          runTags: ["tag1", "tag2", "exhaustive-tag"],
          bulkActionGroupIds: ["bulk-group-1", "bulk-group-2"],

          // Usage metrics
          usageDurationMs: 12345,
          costInCents: 50,
          baseCostInCents: 25,
        },
      });

      // Wait for replication
      await setTimeout(1500);

      // Query ClickHouse directly to get all columns
      const queryRuns = clickhouse.reader.query({
        name: "exhaustive-replication-test",
        query: "SELECT * FROM trigger_dev.task_runs_v2 FINAL WHERE run_id = {run_id:String}",
        schema: z.any(),
        params: z.object({ run_id: z.string() }),
      });

      const [queryError, result] = await queryRuns({ run_id: taskRun.id });

      expect(queryError).toBeNull();
      expect(result).toHaveLength(1);

      const clickhouseRun = result![0];

      // Exhaustively verify each column
      // Core identifiers
      expect(clickhouseRun.run_id).toBe(taskRun.id);
      expect(clickhouseRun.friendly_id).toBe("run_exhaustive_test");
      expect(clickhouseRun.task_identifier).toBe("exhaustive-task");

      // Environment/project/org
      expect(clickhouseRun.environment_id).toBe(runtimeEnvironment.id);
      expect(clickhouseRun.project_id).toBe(project.id);
      expect(clickhouseRun.organization_id).toBe(organization.id);
      expect(clickhouseRun.environment_type).toBe("PRODUCTION");

      // Engine and execution
      expect(clickhouseRun.engine).toBe("V2");
      expect(clickhouseRun.status).toBe("COMPLETED_SUCCESSFULLY");
      expect(clickhouseRun.attempt).toBe(3);
      expect(clickhouseRun.queue).toBe("exhaustive-queue");
      expect(clickhouseRun.worker_queue).toBe("exhaustive-worker-queue");

      // Relationships
      expect(clickhouseRun.schedule_id).toBe(""); // Empty when not set
      expect(clickhouseRun.batch_id).toBe(batch.id);
      expect(clickhouseRun.root_run_id).toBe(rootRun.id);
      expect(clickhouseRun.parent_run_id).toBe(parentRun.id);
      expect(clickhouseRun.depth).toBe(2);

      // Timestamps (ClickHouse returns DateTime64 as strings in UTC without 'Z' suffix)
      // Helper to parse ClickHouse timestamp strings to milliseconds
      function parseClickhouseTimestamp(ts: string | null): number | null {
        if (ts === null || ts === "1970-01-01 00:00:00.000") return null;
        return new Date(ts + "Z").getTime();
      }

      expect(parseClickhouseTimestamp(clickhouseRun.created_at)).toBe(createdAt.getTime());
      expect(parseClickhouseTimestamp(clickhouseRun.updated_at)).toBe(updatedAt.getTime());
      expect(parseClickhouseTimestamp(clickhouseRun.started_at)).toBe(startedAt.getTime());
      expect(parseClickhouseTimestamp(clickhouseRun.executed_at)).toBe(executedAt.getTime());
      expect(parseClickhouseTimestamp(clickhouseRun.completed_at)).toBe(completedAt.getTime());
      expect(parseClickhouseTimestamp(clickhouseRun.delay_until)).toBe(delayUntil.getTime());
      expect(parseClickhouseTimestamp(clickhouseRun.queued_at)).toBe(queuedAt.getTime());
      expect(parseClickhouseTimestamp(clickhouseRun.expired_at)).toBeNull();

      // Output (parsed JSON)
      expect(clickhouseRun.output).toEqual({ data: { result: "test-output" } });

      // Error
      expect(clickhouseRun.error).toEqual({
        data: { message: "test error", name: "TestError" },
      });

      // Tracing
      expect(clickhouseRun.trace_id).toBe("exhaustive-trace-id-12345");
      expect(clickhouseRun.span_id).toBe("exhaustive-span-id-67890");

      // Versioning
      expect(clickhouseRun.task_version).toBe("1.2.3");
      expect(clickhouseRun.sdk_version).toBe("3.0.0");
      expect(clickhouseRun.cli_version).toBe("2.5.1");

      // Execution settings
      expect(clickhouseRun.machine_preset).toBe("large-1x");
      expect(clickhouseRun.idempotency_key).toBe("exhaustive-idempotency-key-hashed");
      expect(clickhouseRun.idempotency_key_user).toBe("exhaustive-idempotency-key");
      expect(clickhouseRun.idempotency_key_scope).toBe("run");
      expect(clickhouseRun.expiration_ttl).toBe("1h");
      expect(clickhouseRun.is_test).toBe(1); // ClickHouse returns booleans as integers
      expect(clickhouseRun.concurrency_key).toBe("exhaustive-concurrency-key");
      expect(clickhouseRun.max_duration_in_seconds).toBe(3600);

      // Tags and bulk actions
      expect(clickhouseRun.tags).toEqual(["tag1", "tag2", "exhaustive-tag"]);
      expect(clickhouseRun.bulk_action_group_ids).toEqual(["bulk-group-1", "bulk-group-2"]);

      // Usage metrics
      expect(clickhouseRun.usage_duration_ms).toBe(12345);
      expect(clickhouseRun.cost_in_cents).toBe(50);
      expect(clickhouseRun.base_cost_in_cents).toBe(25);

      // Internal ClickHouse columns
      expect(clickhouseRun._is_deleted).toBe(0);
      expect(clickhouseRun._version).toBeDefined();
      expect(typeof clickhouseRun._version).toBe("number"); // ClickHouse returns UInt64 as number

      // Also verify the payload was inserted into the payloads table
      const queryPayloads = clickhouse.reader.query({
        name: "exhaustive-payload-test",
        query: "SELECT * FROM trigger_dev.raw_task_runs_payload_v1 WHERE run_id = {run_id:String}",
        schema: z.any(),
        params: z.object({ run_id: z.string() }),
      });

      const [payloadError, payloadResult] = await queryPayloads({ run_id: taskRun.id });

      expect(payloadError).toBeNull();
      expect(payloadResult).toHaveLength(1);
      expect(payloadResult![0].run_id).toBe(taskRun.id);
      expect(parseClickhouseTimestamp(payloadResult![0].created_at)).toBe(createdAt.getTime());
      expect(payloadResult![0].payload).toEqual({ data: { input: "test-payload" } });

      await runsReplicationService.stop();
    }
  );
});
