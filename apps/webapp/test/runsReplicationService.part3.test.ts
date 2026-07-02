import { ClickHouse, getTaskRunField } from "@internal/clickhouse";
import { replicationContainerTest } from "@internal/testcontainers";
import { readFile } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { detectBadJsonStrings } from "~/utils/detectBadJsonStrings";
import { TestReplicationClickhouseFactory } from "./utils/testReplicationClickhouseFactory";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsReplicationService (part 3/7)", () => {
  replicationContainerTest(
    "should insert TaskRuns even if there are incomplete Unicode escape sequences in the JSON",
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

  replicationContainerTest(
    "should merge duplicate event+run.id combinations keeping the latest version",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-merge-batch",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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
});
