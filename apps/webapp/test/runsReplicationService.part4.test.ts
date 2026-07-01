import { ClickHouse } from "@internal/clickhouse";
import { replicationContainerTest } from "@internal/testcontainers";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { TaskRunStatus } from "~/database-types";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { TestReplicationClickhouseFactory } from "./utils/testReplicationClickhouseFactory";
import { createInMemoryMetrics, createInMemoryTracing } from "./utils/tracing";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsReplicationService (part 4/7)", () => {
  replicationContainerTest(
    "should replicate updates to an existing TaskRun to ClickHouse",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-update",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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
        logLevel: "warn",
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

      await setTimeout(1000);

      await prisma.taskRun.update({
        where: { id: taskRun.id },
        data: { status: TaskRunStatus.COMPLETED_SUCCESSFULLY },
      });

      await setTimeout(1000);

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

  replicationContainerTest(
    "should replicate deletions of a TaskRun to ClickHouse and mark as deleted",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-delete",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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
        logLevel: "warn",
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

      await setTimeout(1000);

      await prisma.taskRun.delete({
        where: { id: taskRun.id },
      });

      await setTimeout(1000);

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

  replicationContainerTest(
    "should gracefully shutdown and allow a new service to pick up from the correct LSN (handover)",
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
        ackIntervalSeconds: 5,
        logLevel: "warn",
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

      const run1Id = `run_shutdown_handover_1_${Date.now()}`;

      runsReplicationServiceA.events.on("message", async ({ message, service }) => {
        if (message.tag === "insert") {
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

      await setTimeout(1000);

      const queryRuns = clickhouse.reader.query({
        name: "runs-replication-shutdown-handover",
        query: "SELECT * FROM trigger_dev.task_runs_v2 FINAL ORDER BY created_at ASC",
        schema: z.any(),
      });
      const [queryError, result] = await queryRuns({});
      expect(queryError).toBeNull();
      expect(result?.length).toBe(1);
      expect(result?.[0]).toEqual(expect.objectContaining({ run_id: taskRun1.id }));

      // Service B
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
        ackIntervalSeconds: 5,
        logLevel: "warn",
      });

      await runsReplicationServiceB.start();

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

  replicationContainerTest(
    "should not re-process already handled data if shutdown is called after all transactions are processed",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-shutdown-after-processed",
        logLevel: "warn",
      });

      // Service A
      const runsReplicationServiceA = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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
        logLevel: "warn",
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

      await setTimeout(1000);

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

      await runsReplicationServiceA.shutdown();

      await setTimeout(500);

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
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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
        logLevel: "warn",
      });

      await runsReplicationServiceB.start();

      await setTimeout(1000);

      const [queryErrorB, resultB] = await queryRuns({ run_id: taskRun2.id });
      expect(queryErrorB).toBeNull();
      expect(resultB?.length).toBe(1);
      expect(resultB?.[0]).toEqual(expect.objectContaining({ run_id: taskRun2.id }));

      await runsReplicationServiceB.stop();
    }
  );

  replicationContainerTest(
    "should record metrics with correct values when replicating runs",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-metrics",
        logLevel: "warn",
      });

      const { tracer } = createInMemoryTracing();
      const metricsHelper = createInMemoryMetrics();

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication-metrics",
        slotName: "task_runs_to_clickhouse_v1",
        publicationName: "task_runs_to_clickhouse_v1_publication",
        redisOptions,
        maxFlushConcurrency: 2,
        flushIntervalMs: 100,
        flushBatchSize: 5,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        ackIntervalSeconds: 5,
        tracer,
        meter: metricsHelper.meter,
        logLevel: "warn",
      });

      await runsReplicationService.start();

      const organization = await prisma.organization.create({
        data: {
          title: "test-metrics",
          slug: "test-metrics",
        },
      });

      const project = await prisma.project.create({
        data: {
          name: "test-metrics",
          slug: "test-metrics",
          organizationId: organization.id,
          externalRef: "test-metrics",
        },
      });

      const runtimeEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "test-metrics",
          type: "DEVELOPMENT",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "test-metrics",
          pkApiKey: "test-metrics",
          shortcode: "test-metrics",
        },
      });

      const now = Date.now();
      const createdRuns: string[] = [];

      for (let i = 0; i < 5; i++) {
        const run = await prisma.taskRun.create({
          data: {
            friendlyId: `run_metrics_${now}_${i}`,
            taskIdentifier: "my-task-metrics",
            payload: JSON.stringify({ index: i }),
            payloadType: "application/json",
            traceId: `metrics-${now}-${i}`,
            spanId: `metrics-${now}-${i}`,
            queue: "test-metrics",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
            status: "PENDING",
          },
        });
        createdRuns.push(run.id);
      }

      await setTimeout(1000);

      for (let i = 0; i < 3; i++) {
        await prisma.taskRun.update({
          where: { id: createdRuns[i] },
          data: { status: "EXECUTING" },
        });
      }

      await setTimeout(1000);

      for (let i = 0; i < 2; i++) {
        await prisma.taskRun.update({
          where: { id: createdRuns[i] },
          data: {
            status: "COMPLETED_SUCCESSFULLY",
            completedAt: new Date(),
            output: JSON.stringify({ result: "success" }),
            outputType: "application/json",
          },
        });
      }

      await setTimeout(1000);

      const metrics = await metricsHelper.getMetrics();

      function getMetricData(name: string) {
        for (const resourceMetrics of metrics) {
          for (const scopeMetrics of resourceMetrics.scopeMetrics) {
            for (const metric of scopeMetrics.metrics) {
              if (metric.descriptor.name === name) {
                return metric;
              }
            }
          }
        }
        return null;
      }

      function sumCounterValues(metric: any): number {
        if (!metric?.dataPoints) return 0;
        return metric.dataPoints.reduce((sum: number, dp: any) => sum + (dp.value || 0), 0);
      }

      function histogramHasData(metric: any): boolean {
        if (!metric?.dataPoints || metric.dataPoints.length === 0) return false;
        return metric.dataPoints.some((dp: any) => {
          return (
            (typeof dp.count === "number" && dp.count > 0) ||
            (typeof dp.value?.count === "number" && dp.value.count > 0) ||
            (Array.isArray(dp.buckets?.counts) && dp.buckets.counts.some((c: number) => c > 0)) ||
            (typeof dp.sum === "number" && dp.sum > 0) ||
            typeof dp.min === "number" ||
            typeof dp.max === "number"
          );
        });
      }

      function getCounterAttributeValues(metric: any, attributeName: string): unknown[] {
        if (!metric?.dataPoints) return [];
        return metric.dataPoints
          .filter((dp: any) => dp.attributes?.[attributeName] !== undefined)
          .map((dp: any) => dp.attributes[attributeName]);
      }

      const batchesFlushed = getMetricData("runs_replication.batches_flushed");
      expect(batchesFlushed).not.toBeNull();
      const totalBatchesFlushed = sumCounterValues(batchesFlushed);
      expect(totalBatchesFlushed).toBeGreaterThanOrEqual(1);

      const successAttributeValues = getCounterAttributeValues(batchesFlushed, "success");
      expect(successAttributeValues.length).toBeGreaterThanOrEqual(1);

      const taskRunsInserted = getMetricData("runs_replication.task_runs_inserted");
      expect(taskRunsInserted).not.toBeNull();
      const totalTaskRunsInserted = sumCounterValues(taskRunsInserted);
      expect(totalTaskRunsInserted).toBeGreaterThanOrEqual(5);

      const payloadsInserted = getMetricData("runs_replication.payloads_inserted");
      expect(payloadsInserted).not.toBeNull();
      const totalPayloadsInserted = sumCounterValues(payloadsInserted);
      expect(totalPayloadsInserted).toBeGreaterThanOrEqual(1);

      const eventsProcessed = getMetricData("runs_replication.events_processed");
      expect(eventsProcessed).not.toBeNull();
      const totalEventsProcessed = sumCounterValues(eventsProcessed);
      expect(totalEventsProcessed).toBeGreaterThanOrEqual(1);

      const eventTypes = getCounterAttributeValues(eventsProcessed, "event_type");
      expect(eventTypes.length).toBeGreaterThanOrEqual(1);
      expect(eventTypes).toContain("insert");

      const batchSize = getMetricData("runs_replication.batch_size");
      expect(batchSize).not.toBeNull();
      expect(histogramHasData(batchSize)).toBe(true);

      const replicationLag = getMetricData("runs_replication.replication_lag_ms");
      expect(replicationLag).not.toBeNull();
      expect(histogramHasData(replicationLag)).toBe(true);

      const flushDuration = getMetricData("runs_replication.flush_duration_ms");
      expect(flushDuration).not.toBeNull();
      expect(histogramHasData(flushDuration)).toBe(true);

      await runsReplicationService.stop();
      await metricsHelper.shutdown();
    }
  );
});
