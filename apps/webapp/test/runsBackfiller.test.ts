import { ClickHouse } from "@internal/clickhouse";
import { containerTest } from "@internal/testcontainers";
import { z } from "zod";
import { RunsBackfillerService } from "~/services/runsBackfiller.server";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { createInMemoryTracing } from "./utils/tracing";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsBackfillerService", () => {
  containerTest(
    "should backfill completed runs to clickhouse",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
        compression: {
          request: true,
        },
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

      // Insert 11 completed runs into the database
      for (let i = 0; i < 11; i++) {
        await prisma.taskRun.create({
          data: {
            friendlyId: `run_1234_${i}`,
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
            status: "COMPLETED_SUCCESSFULLY",
          },
        });
      }

      // Insert a second run that's not completed
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_1235",
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
          status: "PENDING",
        },
      });

      // Insert a third run that was created before the "from" date
      await prisma.taskRun.create({
        data: {
          friendlyId: "run_1236",
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
          status: "COMPLETED_SUCCESSFULLY",
          createdAt: new Date(Date.now() - 60000), // 60 seconds ago
        },
      });

      const service = new RunsBackfillerService({
        prisma,
        runsReplicationInstance: runsReplicationService,
        tracer,
      });

      const from = new Date(Date.now() - 10000);
      const to = new Date(Date.now() + 1000);

      const backfillResult = await service.call({
        from,
        to,
        batchSize: 10,
      });

      expect(backfillResult).toBeDefined();

      // Okay now use the cursor to backfill again for the next batch
      const backfillResult2 = await service.call({
        from,
        to,
        batchSize: 10,
        cursor: backfillResult,
      });

      expect(backfillResult2).toBeDefined();

      // Now use the cursor to backfill again for the next batch, but this time it will return undefined because there are no more runs to backfill
      const backfillResult3 = await service.call({
        from,
        to,
        batchSize: 10,
        cursor: backfillResult2,
      });

      expect(backfillResult3).toBeUndefined();

      // Check that the row was replicated to clickhouse
      const queryRuns = clickhouse.reader.query({
        name: "runs-replication",
        query: "SELECT * FROM trigger_dev.task_runs_v2",
        schema: z.any(),
      });

      const [queryError, result] = await queryRuns({});

      expect(queryError).toBeNull();
      expect(result?.length).toBe(11);
    }
  );
});
