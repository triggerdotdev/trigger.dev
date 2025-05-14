import { ClickHouse } from "@internal/clickhouse";
import { containerTest } from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { TaskRunStatus } from "~/database-types";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { createInMemoryTracing } from "./utils/tracing";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsReplicationService", () => {
  containerTest(
    "should replicate runs to clickhouse",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
      });

      const { tracer, exporter } = createInMemoryTracing();

      const runsReplicationService = new RunsReplicationService({
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
        tracer,
      });

      await runsReplicationService.start();

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

      await setTimeout(1000);

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

      const spans = exporter.getFinishedSpans();

      expect(spans.length).toBeGreaterThan(0);

      const transactionSpan = spans.find(
        (span) =>
          span.name === "handle_transaction" &&
          typeof span.attributes["transaction.events"] === "number" &&
          span.attributes["transaction.events"] > 0
      );

      expect(transactionSpan).not.toBeNull();
      expect(transactionSpan?.attributes["transaction.parse_duration_ms"]).toBeGreaterThan(0);
      expect(transactionSpan?.attributes["transaction.parse_duration_ms"]).toBeLessThan(1);

      await runsReplicationService.stop();
    }
  );

  containerTest(
    "should not produce any handle_transaction spans when no TaskRun events are produced",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
      });

      const { tracer, exporter } = createInMemoryTracing();

      const runsReplicationService = new RunsReplicationService({
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
        tracer,
      });

      await runsReplicationService.start();

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

      await prisma.runtimeEnvironment.create({
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

      await setTimeout(1000);

      const spans = exporter.getFinishedSpans();

      const handleTransactionSpans = spans.filter((span) => span.name === "handle_transaction");

      expect(handleTransactionSpans.length).toBe(0);

      await runsReplicationService.stop();
    }
  );

  containerTest(
    "should replicate a new TaskRun to ClickHouse using batching insert strategy",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-batching",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-batching",
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

      const organization = await prisma.organization.create({
        data: {
          title: "test-batching",
          slug: "test-batching",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-batching",
          slug: "test-batching",
          organizationId: organization.id,
          externalRef: "test-batching",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-batching",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test-batching",
          pkApiKey: "test-batching",
          shortcode: "test-batching",
        },
      });

      // Insert a row into the table with a unique friendlyId
      const uniqueFriendlyId = `run_batching_${Date.now()}`;
      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: uniqueFriendlyId,
          taskIdentifier: "my-task-batching",
          payload: JSON.stringify({ foo: "bar-batching" }),
          traceId: "batching-1234",
          spanId: "batching-1234",
          queue: "test-batching",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      // Wait for replication
      await setTimeout(1000);

      // Query ClickHouse for the replicated run
      const queryRuns = clickhouse.reader.query({
        name: "runs-replication-batching",
        query: "SELECT * FROM trigger_dev.task_runs_v2 WHERE run_id = {run_id:String}",
        schema: z.any(),
        params: z.object({ run_id: z.string() }),
      });

      const [queryError, result] = await queryRuns({ run_id: taskRun.id });

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

      await runsReplicationService.stop();
    }
  );

  containerTest(
    "should insert the payload into ClickHouse when a TaskRun is created",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-payload",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-payload",
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

      const organization = await prisma.organization.create({
        data: {
          title: "test-payload",
          slug: "test-payload",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-payload",
          slug: "test-payload",
          organizationId: organization.id,
          externalRef: "test-payload",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-payload",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test-payload",
          pkApiKey: "test-payload",
          shortcode: "test-payload",
        },
      });

      // Insert a row into the table with a unique payload
      const uniquePayload = { foo: "payload-test", bar: Date.now() };
      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: `run_payload_${Date.now()}`,
          taskIdentifier: "my-task-payload",
          payload: JSON.stringify(uniquePayload),
          payloadType: "application/json",
          traceId: "payload-1234",
          spanId: "payload-1234",
          queue: "test-payload",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      // Wait for replication
      await setTimeout(1000);

      // Query ClickHouse for the replicated payload
      const queryPayloads = clickhouse.reader.query({
        name: "runs-replication-payload",
        query: "SELECT * FROM trigger_dev.raw_task_runs_payload_v1 WHERE run_id = {run_id:String}",
        schema: z.any(),
        params: z.object({ run_id: z.string() }),
      });

      const [queryError, result] = await queryPayloads({ run_id: taskRun.id });

      expect(queryError).toBeNull();
      expect(result?.length).toBe(1);
      expect(result?.[0]).toEqual(
        expect.objectContaining({
          run_id: taskRun.id,
          payload: expect.objectContaining({
            data: uniquePayload,
          }),
        })
      );

      await runsReplicationService.stop();
    }
  );

  containerTest(
    "should insert the payload even if it's very large into ClickHouse when a TaskRun is created",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-payload",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-payload",
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

      const organization = await prisma.organization.create({
        data: {
          title: "test-payload",
          slug: "test-payload",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-payload",
          slug: "test-payload",
          organizationId: organization.id,
          externalRef: "test-payload",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-payload",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test-payload",
          pkApiKey: "test-payload",
          shortcode: "test-payload",
        },
      });

      // Insert a row into the table with a unique payload
      const largePayload = {
        foo: Array.from({ length: 100 }, () => "foo").join(""),
        bar: Array.from({ length: 100 }, () => "bar").join(""),
        baz: Array.from({ length: 100 }, () => "baz").join(""),
      };

      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: `run_payload_${Date.now()}`,
          taskIdentifier: "my-task-payload",
          payload: JSON.stringify(largePayload),
          payloadType: "application/json",
          traceId: "payload-1234",
          spanId: "payload-1234",
          queue: "test-payload",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      // Wait for replication
      await setTimeout(1000);

      // Query ClickHouse for the replicated payload
      const queryPayloads = clickhouse.reader.query({
        name: "runs-replication-payload",
        query: "SELECT * FROM trigger_dev.raw_task_runs_payload_v1 WHERE run_id = {run_id:String}",
        schema: z.any(),
        params: z.object({ run_id: z.string() }),
      });

      const [queryError, result] = await queryPayloads({ run_id: taskRun.id });

      expect(queryError).toBeNull();
      expect(result?.length).toBe(1);
      expect(result?.[0]).toEqual(
        expect.objectContaining({
          run_id: taskRun.id,
          payload: expect.objectContaining({
            data: largePayload,
          }),
        })
      );

      await runsReplicationService.stop();
    }
  );

  containerTest(
    "should replicate updates to an existing TaskRun to ClickHouse",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-update",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-update",
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

      const organization = await prisma.organization.create({
        data: {
          title: "test-update",
          slug: "test-update",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-update",
          slug: "test-update",
          organizationId: organization.id,
          externalRef: "test-update",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-update",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test-update",
          pkApiKey: "test-update",
          shortcode: "test-update",
        },
      });

      // Insert a row into the table
      const uniqueFriendlyId = `run_update_${Date.now()}`;
      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: uniqueFriendlyId,
          taskIdentifier: "my-task-update",
          payload: JSON.stringify({ foo: "update-test" }),
          payloadType: "application/json",
          traceId: "update-1234",
          spanId: "update-1234",
          queue: "test-update",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          status: "PENDING",
        },
      });

      // Wait for initial replication
      await setTimeout(1000);

      // Update the status field
      await prisma.taskRun.update({
        where: { id: taskRun.id },
        data: { status: TaskRunStatus.COMPLETED_SUCCESSFULLY },
      });

      // Wait for replication
      await setTimeout(1000);

      // Query ClickHouse for the replicated run
      const queryRuns = clickhouse.reader.query({
        name: "runs-replication-update",
        query: "SELECT * FROM trigger_dev.task_runs_v2 FINAL WHERE run_id = {run_id:String}",
        schema: z.any(),
        params: z.object({ run_id: z.string() }),
      });

      const [queryError, result] = await queryRuns({ run_id: taskRun.id });

      expect(queryError).toBeNull();
      expect(result?.length).toBe(1);
      expect(result?.[0]).toEqual(
        expect.objectContaining({
          run_id: taskRun.id,
          status: TaskRunStatus.COMPLETED_SUCCESSFULLY,
        })
      );

      await runsReplicationService.stop();
    }
  );

  containerTest(
    "should replicate deletions of a TaskRun to ClickHouse and mark as deleted",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-delete",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-delete",
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

      const organization = await prisma.organization.create({
        data: {
          title: "test-delete",
          slug: "test-delete",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-delete",
          slug: "test-delete",
          organizationId: organization.id,
          externalRef: "test-delete",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-delete",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test-delete",
          pkApiKey: "test-delete",
          shortcode: "test-delete",
        },
      });

      // Insert a row into the table
      const uniqueFriendlyId = `run_delete_${Date.now()}`;
      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: uniqueFriendlyId,
          taskIdentifier: "my-task-delete",
          payload: JSON.stringify({ foo: "delete-test" }),
          payloadType: "application/json",
          traceId: "delete-1234",
          spanId: "delete-1234",
          queue: "test-delete",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          status: "PENDING",
        },
      });

      // Wait for initial replication
      await setTimeout(1000);

      // Delete the TaskRun
      await prisma.taskRun.delete({
        where: { id: taskRun.id },
      });

      // Wait for replication
      await setTimeout(1000);

      // Query ClickHouse for the replicated run using FINAL
      const queryRuns = clickhouse.reader.query({
        name: "runs-replication-delete",
        query: "SELECT * FROM trigger_dev.task_runs_v2 FINAL WHERE run_id = {run_id:String}",
        schema: z.any(),
        params: z.object({ run_id: z.string() }),
      });

      const [queryError, result] = await queryRuns({ run_id: taskRun.id });

      expect(queryError).toBeNull();
      expect(result?.length).toBe(0);

      await runsReplicationService.stop();
    }
  );

  containerTest(
    "should gracefully shutdown and allow a new service to pick up from the correct LSN (handover)",
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
        ackIntervalSeconds: 5,
      });

      await runsReplicationServiceA.start();

      const organization = await prisma.organization.create({
        data: {
          title: "test-shutdown-handover",
          slug: "test-shutdown-handover",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-shutdown-handover",
          slug: "test-shutdown-handover",
          organizationId: organization.id,
          externalRef: "test-shutdown-handover",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-shutdown-handover",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test-shutdown-handover",
          pkApiKey: "test-shutdown-handover",
          shortcode: "test-shutdown-handover",
        },
      });

      // Insert Run 1
      const run1Id = `run_shutdown_handover_1_${Date.now()}`;

      // Initiate shutdown when the first insert message is received
      runsReplicationServiceA.events.on("message", async ({ message, service }) => {
        if (message.tag === "insert") {
          // Initiate shutdown
          await service.shutdown();
        }
      });

      const taskRun1 = await prisma.taskRun.create({
        data: {
          friendlyId: run1Id,
          taskIdentifier: "my-task-shutdown-handover-1",
          payload: JSON.stringify({ foo: "handover-1" }),
          payloadType: "application/json",
          traceId: "handover-1-1234",
          spanId: "handover-1-1234",
          queue: "test-shutdown-handover",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          status: "PENDING",
        },
      });

      // Insert Run 2 after shutdown is initiated
      const run2Id = `run_shutdown_handover_2_${Date.now()}`;
      const taskRun2 = await prisma.taskRun.create({
        data: {
          friendlyId: run2Id,
          taskIdentifier: "my-task-shutdown-handover-2",
          payload: JSON.stringify({ foo: "handover-2" }),
          payloadType: "application/json",
          traceId: "handover-2-1234",
          spanId: "handover-2-1234",
          queue: "test-shutdown-handover",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          status: "PENDING",
        },
      });

      // Wait for flush to complete
      await setTimeout(1000);

      // Query ClickHouse for both runs using FINAL
      const queryRuns = clickhouse.reader.query({
        name: "runs-replication-shutdown-handover",
        query: "SELECT * FROM trigger_dev.task_runs_v2 FINAL ORDER BY created_at ASC",
        schema: z.any(),
      });

      // Make sure only the first run is in ClickHouse
      const [queryError, result] = await queryRuns({});
      expect(queryError).toBeNull();
      expect(result?.length).toBe(1);
      expect(result?.[0]).toEqual(expect.objectContaining({ run_id: taskRun1.id }));

      // Service B
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
        ackIntervalSeconds: 5,
      });

      await runsReplicationServiceB.start();

      // Wait for replication
      await setTimeout(1000);

      const [queryErrorB, resultB] = await queryRuns({});

      expect(queryErrorB).toBeNull();
      expect(resultB?.length).toBe(2);
      expect(resultB).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ run_id: taskRun1.id }),
          expect.objectContaining({ run_id: taskRun2.id }),
        ])
      );

      await runsReplicationServiceB.stop();
    }
  );

  containerTest(
    "should not re-process already handled data if shutdown is called after all transactions are processed",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-shutdown-after-processed",
      });

      // Service A
      const runsReplicationServiceA = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-shutdown-after-processed",
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

      await runsReplicationServiceA.start();

      const organization = await prisma.organization.create({
        data: {
          title: "test-shutdown-after-processed",
          slug: "test-shutdown-after-processed",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-shutdown-after-processed",
          slug: "test-shutdown-after-processed",
          organizationId: organization.id,
          externalRef: "test-shutdown-after-processed",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-shutdown-after-processed",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test-shutdown-after-processed",
          pkApiKey: "test-shutdown-after-processed",
          shortcode: "test-shutdown-after-processed",
        },
      });

      // Insert Run 1
      const run1Id = `run_shutdown_after_processed_${Date.now()}`;
      const taskRun1 = await prisma.taskRun.create({
        data: {
          friendlyId: run1Id,
          taskIdentifier: "my-task-shutdown-after-processed",
          payload: JSON.stringify({ foo: "after-processed" }),
          payloadType: "application/json",
          traceId: "after-processed-1234",
          spanId: "after-processed-1234",
          queue: "test-shutdown-after-processed",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          status: "PENDING",
        },
      });

      // Wait for replication to ensure transaction is processed
      await setTimeout(1000);

      // Query ClickHouse for the run using FINAL
      const queryRuns = clickhouse.reader.query({
        name: "runs-replication-shutdown-after-processed",
        query: "SELECT * FROM trigger_dev.task_runs_v2 FINAL WHERE run_id = {run_id:String}",
        schema: z.any(),
        params: z.object({ run_id: z.string() }),
      });

      const [queryErrorA, resultA] = await queryRuns({ run_id: taskRun1.id });
      expect(queryErrorA).toBeNull();
      expect(resultA?.length).toBe(1);
      expect(resultA?.[0]).toEqual(expect.objectContaining({ run_id: taskRun1.id }));

      // Shutdown after all transactions are processed
      await runsReplicationServiceA.shutdown();

      await setTimeout(500); // Give a moment for shutdown

      // Insert another run
      const taskRun2 = await prisma.taskRun.create({
        data: {
          friendlyId: `run_shutdown_after_processed_${Date.now()}`,
          taskIdentifier: "my-task-shutdown-after-processed",
          payload: JSON.stringify({ foo: "after-processed-2" }),
          payloadType: "application/json",
          traceId: "after-processed-2-1234",
          spanId: "after-processed-2-1234",
          queue: "test-shutdown-after-processed",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          status: "PENDING",
        },
      });

      // Service B
      const runsReplicationServiceB = new RunsReplicationService({
        clickhouse,
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-shutdown-after-processed",
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

      await runsReplicationServiceB.start();

      await setTimeout(1000);

      // Query ClickHouse for the second run
      const [queryErrorB, resultB] = await queryRuns({ run_id: taskRun2.id });
      expect(queryErrorB).toBeNull();
      expect(resultB?.length).toBe(1);
      expect(resultB?.[0]).toEqual(expect.objectContaining({ run_id: taskRun2.id }));

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

      // Wait for 4 minutes
      await setTimeout(4 * 60 * 1000);

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

      // Check that there are between 200 and 480 runs in ClickHouse
      expect(result?.length).toBeGreaterThanOrEqual(200);
      expect(result?.length).toBeLessThanOrEqual(480);

      await runsReplicationService.stop();
    },
    { timeout: 60_000 * 5 }
  );
});
