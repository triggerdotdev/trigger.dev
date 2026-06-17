import { ClickHouse } from "@internal/clickhouse";
import { replicationContainerTest } from "@internal/testcontainers";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { TaskRunStatus } from "~/database-types";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { createInMemoryTracing, createInMemoryMetrics } from "./utils/tracing";
import { TestReplicationClickhouseFactory } from "./utils/testReplicationClickhouseFactory";
import superjson from "superjson";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsReplicationService (part 1/7)", () => {
  replicationContainerTest(
    "should replicate runs to clickhouse",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
        compression: {
          request: true,
        },
        logLevel: "warn",
      });

      const { tracer, exporter } = createInMemoryTracing();

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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
        logLevel: "warn",
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

      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1234",
          spanId: "1234",
          queue: "test",
          workerQueue: "us-east-1-next",
          region: "us-east-1",
          planType: "free",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
          annotations: {
            triggerSource: "api",
            triggerAction: "trigger",
            rootTriggerSource: "dashboard",
          },
          isWarmStart: true,
        },
      });

      await setTimeout(1000);

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
          trigger_source: "api",
          root_trigger_source: "dashboard",
          is_warm_start: 1,
          // worker_queue stays the raw backing (operators); region is the geo (customers)
          worker_queue: "us-east-1-next",
          region: "us-east-1",
          plan_type: "free",
        })
      );

      const spans = exporter.getFinishedSpans();

      expect(spans.length).toBeGreaterThan(0);

      const flushBatchSpan = spans.find((span) => span.name === "flushBatch");
      expect(flushBatchSpan).toBeDefined();

      await runsReplicationService.stop();
    }
  );

  replicationContainerTest(
    "should replicate runs with super json payloads to clickhouse",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
        compression: {
          request: true,
        },
        logLevel: "warn",
      });

      const { tracer, exporter } = createInMemoryTracing();

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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
        logLevel: "warn",
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

      const date = new Date();

      const taskRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1234",
          taskIdentifier: "my-task",
          payload: superjson.stringify({
            foo: "bar",
            bigint: BigInt(1234),
            date,
            map: new Map([["foo", "bar"]]),
          }),
          payloadType: "application/super+json",
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

      const queryPayloads = clickhouse.reader.query({
        name: "runs-replication",
        query: "SELECT * FROM trigger_dev.raw_task_runs_payload_v1 WHERE run_id = {run_id:String}",
        schema: z.any(),
        params: z.object({ run_id: z.string() }),
      });

      const [payloadQueryError, payloadResult] = await queryPayloads({ run_id: taskRun.id });

      expect(payloadQueryError).toBeNull();
      expect(payloadResult?.length).toBe(1);
      expect(payloadResult?.[0]).toEqual(
        expect.objectContaining({
          run_id: taskRun.id,
          payload: {
            data: expect.objectContaining({
              foo: "bar",
              bigint: "1234",
              date: date.toISOString(),
              map: [["foo", "bar"]],
            }),
          },
        })
      );

      await runsReplicationService.stop();
    }
  );

  replicationContainerTest(
    "should not produce any flush spans when no TaskRun events are produced",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
        logLevel: "warn",
      });

      const { tracer, exporter } = createInMemoryTracing();

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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
        logLevel: "warn",
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

      const flushBatchSpans = spans.filter((span) => span.name === "flushBatch");

      expect(flushBatchSpans.length).toBe(0);

      await runsReplicationService.stop();
    }
  );

  replicationContainerTest(
    "should replicate a new TaskRun to ClickHouse using batching insert strategy",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-batching",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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
        logLevel: "warn",
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

      await setTimeout(1000);

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

  replicationContainerTest(
    "should insert the payload into ClickHouse when a TaskRun is created",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-payload",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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
        logLevel: "warn",
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

      await setTimeout(1000);

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

  replicationContainerTest(
    "should insert the payload even if it's very large into ClickHouse when a TaskRun is created",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-payload",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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
        logLevel: "warn",
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

      await setTimeout(1000);

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
});
