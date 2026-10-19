import { ClickHouse } from "@internal/clickhouse";
import { replicationContainerTest } from "@internal/testcontainers";
import { z } from "zod";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { TestReplicationClickhouseFactory } from "./utils/testReplicationClickhouseFactory";
import { createInMemoryTracing } from "./utils/tracing";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsReplicationService worker_cell and worker_lane", () => {
  replicationContainerTest(
    "projects the worker stamp from annotations, including when the blob fails RunAnnotations validation",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
        compression: { request: true },
        logLevel: "warn",
      });

      const { tracer } = createInMemoryTracing();

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
        pgConnectionUrl: postgresContainer.getConnectionUri(),
        serviceName: "runs-replication",
        slotName: "task_runs_to_clickhouse_v1",
        publicationName: "task_runs_to_clickhouse_v1_publication",
        redisOptions,
        maxFlushConcurrency: 1,
        flushIntervalMs: 100,
        flushBatchSize: 10,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        ackIntervalSeconds: 5,
        tracer,
        logLevel: "warn",
      });

      await runsReplicationService.start();

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

      const baseRun = {
        taskIdentifier: "my-task",
        payload: JSON.stringify({ foo: "bar" }),
        queue: "test",
        runtimeEnvironmentId: runtimeEnvironment.id,
        projectId: project.id,
        organizationId: organization.id,
        environmentType: "DEVELOPMENT" as const,
        engine: "V2" as const,
      };

      const stamped = await prisma.taskRun.create({
        data: {
          ...baseRun,
          friendlyId: "run_1234",
          traceId: "1234",
          spanId: "1234",
          annotations: {
            triggerSource: "sdk",
            triggerAction: "trigger",
            rootTriggerSource: "sdk",
            workerCell: "cell-a",
            workerLane: "microvm",
          },
        },
      });

      const unstamped = await prisma.taskRun.create({
        data: {
          ...baseRun,
          friendlyId: "run_1235",
          traceId: "1235",
          spanId: "1235",
          annotations: {
            triggerSource: "sdk",
            triggerAction: "trigger",
            rootTriggerSource: "sdk",
          },
        },
      });

      const stampedOnBrokenBlob = await prisma.taskRun.create({
        data: {
          ...baseRun,
          friendlyId: "run_1236",
          traceId: "1236",
          spanId: "1236",
          annotations: {
            workerCell: "cell-b",
            workerLane: "container",
          },
        },
      });

      const noAnnotations = await prisma.taskRun.create({
        data: {
          ...baseRun,
          friendlyId: "run_1237",
          traceId: "1237",
          spanId: "1237",
        },
      });

      const queryRuns = clickhouse.reader.query({
        name: "runs-replication",
        query: "SELECT run_id, worker_cell, worker_lane FROM trigger_dev.task_runs_v2",
        schema: z.any(),
      });

      const rows = await vi.waitFor(
        async () => {
          const [queryError, result] = await queryRuns({});

          expect(queryError).toBeNull();
          expect(result?.length).toBe(4);

          return result;
        },
        { timeout: 30_000, interval: 250 }
      );

      const byRunId = new Map<string, { worker_cell: string; worker_lane: string }>(
        (rows ?? []).map((row: { run_id: string; worker_cell: string; worker_lane: string }) => [
          row.run_id,
          { worker_cell: row.worker_cell, worker_lane: row.worker_lane },
        ])
      );

      expect(byRunId.get(stamped.id)).toEqual({ worker_cell: "cell-a", worker_lane: "microvm" });
      expect(byRunId.get(unstamped.id)).toEqual({ worker_cell: "", worker_lane: "" });
      expect(byRunId.get(stampedOnBrokenBlob.id)).toEqual({
        worker_cell: "cell-b",
        worker_lane: "container",
      });
      expect(byRunId.get(noAnnotations.id)).toEqual({ worker_cell: "", worker_lane: "" });

      // An attempt start stamps an unstamped run; an unstamped retry clears a stamped one.
      await prisma.taskRun.update({
        where: { id: unstamped.id },
        data: {
          annotations: {
            triggerSource: "sdk",
            triggerAction: "trigger",
            rootTriggerSource: "sdk",
            workerCell: "cell-c",
            workerLane: "container",
          },
        },
      });
      await prisma.taskRun.update({
        where: { id: stamped.id },
        data: {
          annotations: { triggerSource: "sdk", triggerAction: "trigger", rootTriggerSource: "sdk" },
        },
      });

      const queryLatest = clickhouse.reader.query({
        name: "runs-replication",
        query: "SELECT run_id, worker_cell, worker_lane FROM trigger_dev.task_runs_v2 FINAL",
        schema: z.any(),
      });

      await vi.waitFor(
        async () => {
          const [queryError, result] = await queryLatest({});

          expect(queryError).toBeNull();

          const latest = new Map<string, { worker_cell: string; worker_lane: string }>(
            (result ?? []).map(
              (row: { run_id: string; worker_cell: string; worker_lane: string }) => [
                row.run_id,
                { worker_cell: row.worker_cell, worker_lane: row.worker_lane },
              ]
            )
          );

          expect(latest.get(unstamped.id)).toEqual({
            worker_cell: "cell-c",
            worker_lane: "container",
          });
          expect(latest.get(stamped.id)).toEqual({ worker_cell: "", worker_lane: "" });
        },
        { timeout: 30_000, interval: 250 }
      );

      await runsReplicationService.stop();
    }
  );
});
