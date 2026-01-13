import { describe, expect, vi } from "vitest";

// Mock the db prisma client
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { containerTest } from "@internal/testcontainers";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { setupClickhouseReplication } from "./utils/replicationUtils";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsRepository (part 2/2)", () => {
  containerTest(
    "should filter runs by rootOnly flag",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

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

      // Create a root run
      const rootRun = await prisma.taskRun.create({
        data: {
          friendlyId: "run_root",
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

      // Create a child run
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_child",
          taskIdentifier: "my-task",
          rootTaskRunId: rootRun.id,
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1235",
          spanId: "1235",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await setTimeout(1000);

      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
      });

      // Test filtering by rootOnly=true
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        rootOnly: true,
      });

      expect(runs).toHaveLength(1);
      expect(runs[0].friendlyId).toBe("run_root");
    }
  );

  containerTest(
    "should filter runs by batchId",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

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

      const batchRun1 = await prisma.batchTaskRun.create({
        data: {
          friendlyId: "batch_1",
          runtimeEnvironmentId: runtimeEnvironment.id,
          status: "PENDING",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // Create runs with different batch IDs
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_batch_1",
          taskIdentifier: "my-task",
          batchId: batchRun1.id,
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

      const batchRun2 = await prisma.batchTaskRun.create({
        data: {
          friendlyId: "batch_2",
          runtimeEnvironmentId: runtimeEnvironment.id,
          status: "PENDING",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_batch_2",
          taskIdentifier: "my-task",
          batchId: batchRun2.id,
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1235",
          spanId: "1235",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_no_batch",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1236",
          spanId: "1236",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await setTimeout(1000);

      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
      });

      // Test filtering by batch ID
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        batchId: batchRun1.id,
      });

      expect(runs).toHaveLength(1);
      expect(runs[0].friendlyId).toBe("run_batch_1");
    }
  );

  containerTest(
    "should filter runs by runFriendlyIds",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

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

      // Create runs with different friendly IDs
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_abc",
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

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_def",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1235",
          spanId: "1235",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_xyz",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1236",
          spanId: "1236",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await setTimeout(1000);

      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
      });

      // Test filtering by friendly IDs
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        runId: ["run_abc", "run_xyz"],
      });

      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.friendlyId).sort()).toEqual(["run_abc", "run_xyz"]);
    }
  );

  containerTest(
    "should filter runs by runIds",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

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

      // Create runs to get their IDs
      const run1 = await prisma.taskRun.create({
        data: {
          friendlyId: "run_1",
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

      const run2 = await prisma.taskRun.create({
        data: {
          friendlyId: "run_2",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1235",
          spanId: "1235",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      const run3 = await prisma.taskRun.create({
        data: {
          friendlyId: "run_3",
          taskIdentifier: "my-task",
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1236",
          spanId: "1236",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await setTimeout(1_000);

      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
      });

      // Test filtering by run IDs
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        runId: [run1.friendlyId, run3.friendlyId],
      });

      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.id).sort()).toEqual([run1.id, run3.id].sort());
    }
  );

  containerTest(
    "should filter runs by date range (from/to)",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

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

      const now = new Date();
      const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      // Create runs with different creation dates
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_yesterday",
          taskIdentifier: "my-task",
          createdAt: yesterday,
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

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_today",
          taskIdentifier: "my-task",
          createdAt: now,
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1235",
          spanId: "1235",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_tomorrow",
          taskIdentifier: "my-task",
          createdAt: tomorrow,
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1236",
          spanId: "1236",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await setTimeout(1000);

      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
      });

      // Test filtering by date range (from yesterday to today)
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        from: yesterday.getTime(),
        to: now.getTime(),
      });

      expect(runs).toHaveLength(2);
      expect(runs.map((r) => r.friendlyId).sort()).toEqual(["run_today", "run_yesterday"]);
    }
  );

  containerTest(
    "should handle multiple filters combined",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

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

      // Create runs with different combinations of properties
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_match",
          taskIdentifier: "task-1",
          taskVersion: "1.0.0",
          status: "COMPLETED_SUCCESSFULLY",
          isTest: false,
          runTags: ["urgent"],
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

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_no_match_task",
          taskIdentifier: "task-2", // Different task
          taskVersion: "1.0.0",
          status: "COMPLETED_SUCCESSFULLY",
          isTest: false,
          runTags: ["urgent"],
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1235",
          spanId: "1235",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await prisma.taskRun.create({
        data: {
          friendlyId: "run_no_match_status",
          taskIdentifier: "task-1",
          taskVersion: "1.0.0",
          status: "PENDING", // Different status
          isTest: false,
          runTags: ["urgent"],
          payload: JSON.stringify({ foo: "bar" }),
          traceId: "1236",
          spanId: "1236",
          queue: "test",
          runtimeEnvironmentId: runtimeEnvironment.id,
          projectId: project.id,
          organizationId: organization.id,
          environmentType: "DEVELOPMENT",
          engine: "V2",
        },
      });

      await setTimeout(1000);

      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
      });

      // Test combining multiple filters
      const { runs } = await runsRepository.listRuns({
        page: { size: 10 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
        tasks: ["task-1"],
        versions: ["1.0.0"],
        statuses: ["COMPLETED_SUCCESSFULLY"],
        isTest: false,
        tags: ["urgent"],
      });

      expect(runs).toHaveLength(1);
      expect(runs[0].friendlyId).toBe("run_match");
    }
  );

  containerTest(
    "should handle pagination correctly",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

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

      // Create multiple runs for pagination testing
      const runs = [];
      for (let i = 1; i <= 5; i++) {
        const run = await prisma.taskRun.create({
          data: {
            friendlyId: `run_${i}`,
            taskIdentifier: "my-task",
            payload: JSON.stringify({ foo: "bar" }),
            traceId: `123${i}`,
            spanId: `123${i}`,
            queue: "test",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
          },
        });
        runs.push(run);
      }

      await setTimeout(1000);

      const runsRepository = new RunsRepository({
        prisma,
        clickhouse,
      });

      // Test first page
      const firstPage = await runsRepository.listRuns({
        page: { size: 2 },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
      });

      expect(firstPage.runs).toHaveLength(2);
      expect(firstPage.pagination.nextCursor).toBeTruthy();
      expect(firstPage.pagination.previousCursor).toBe(null);

      // Test next page using cursor
      const secondPage = await runsRepository.listRuns({
        page: {
          size: 2,
          cursor: firstPage.pagination.nextCursor!,
          direction: "forward",
        },
        projectId: project.id,
        environmentId: runtimeEnvironment.id,
        organizationId: organization.id,
      });

      expect(secondPage.runs).toHaveLength(2);
      expect(secondPage.pagination.nextCursor).toBeTruthy();
      expect(secondPage.pagination.previousCursor).toBeTruthy();
    }
  );

  containerTest(
    "should exhaustively replicate all TaskRun columns to ClickHouse",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const { clickhouse } = await setupClickhouseReplication({
        prisma,
        databaseUrl: postgresContainer.getConnectionUri(),
        clickhouseUrl: clickhouseContainer.getConnectionUrl(),
        redisOptions,
      });

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

      // Create a schedule for the scheduleId field
      const schedule = await prisma.taskSchedule.create({
        data: {
          friendlyId: "sched_exhaustive",
          taskIdentifier: "my-scheduled-task",
          generatorExpression: "0 0 * * *",
          generatorDescription: "Every day at midnight",
          timezone: "UTC",
          projectId: project.id,
          environmentId: runtimeEnvironment.id,
          userProvidedDeduplicationKey: "test-dedup-key",
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
          masterQueue: "exhaustive-worker-queue",

          // Relationships
          scheduleId: schedule.id,
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
          idempotencyKey: "exhaustive-idempotency-key",
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
      expect(clickhouseRun.schedule_id).toBe(schedule.id);
      expect(clickhouseRun.batch_id).toBe(batch.id);
      expect(clickhouseRun.root_run_id).toBe(rootRun.id);
      expect(clickhouseRun.parent_run_id).toBe(parentRun.id);
      expect(clickhouseRun.depth).toBe(2);

      // Timestamps (ClickHouse stores as milliseconds)
      expect(clickhouseRun.created_at).toBe(createdAt.getTime());
      expect(clickhouseRun.updated_at).toBe(updatedAt.getTime());
      expect(clickhouseRun.started_at).toBe(startedAt.getTime());
      expect(clickhouseRun.executed_at).toBe(executedAt.getTime());
      expect(clickhouseRun.completed_at).toBe(completedAt.getTime());
      expect(clickhouseRun.delay_until).toBe(delayUntil.getTime());
      expect(clickhouseRun.queued_at).toBe(queuedAt.getTime());
      expect(clickhouseRun.expired_at).toBeNull();

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
      expect(clickhouseRun.idempotency_key).toBe("exhaustive-idempotency-key");
      expect(clickhouseRun.expiration_ttl).toBe("1h");
      expect(clickhouseRun.is_test).toBe(true);
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
      expect(typeof clickhouseRun._version).toBe("string");

      // Also verify the payload was inserted into the payloads table
      const queryPayloads = clickhouse.reader.query({
        name: "exhaustive-payload-test",
        query:
          "SELECT * FROM trigger_dev.raw_task_runs_payload_v1 WHERE run_id = {run_id:String}",
        schema: z.any(),
        params: z.object({ run_id: z.string() }),
      });

      const [payloadError, payloadResult] = await queryPayloads({ run_id: taskRun.id });

      expect(payloadError).toBeNull();
      expect(payloadResult).toHaveLength(1);
      expect(payloadResult![0].run_id).toBe(taskRun.id);
      expect(payloadResult![0].created_at).toBe(createdAt.getTime());
      expect(payloadResult![0].payload).toEqual({ data: { input: "test-payload" } });
    }
  );
});