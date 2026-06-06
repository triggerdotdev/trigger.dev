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

describe("RunsReplicationService (part 6/6)", () => {
  replicationContainerTest(
    "should sort batch inserts according to table schema ordering for optimal performance",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public.\"TaskRun\" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-sorting",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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

  replicationContainerTest(
    "should exhaustively replicate all TaskRun columns to ClickHouse",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-exhaustive",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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
