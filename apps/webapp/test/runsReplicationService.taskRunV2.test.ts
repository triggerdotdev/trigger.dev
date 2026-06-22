import { ClickHouse } from "@internal/clickhouse";
import { replicationContainerTest } from "@internal/testcontainers";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { createInMemoryTracing } from "./utils/tracing";
import { TestReplicationClickhouseFactory } from "./utils/testReplicationClickhouseFactory";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsReplicationService (task_run_v2)", () => {
  replicationContainerTest(
    "co-publishes task_run_v2 and streams its rows to the same ClickHouse table",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      // Both tables are in the publication; both need FULL identity so the
      // delete transform can read the old row. INSERTs (this test) carry the
      // full new tuple regardless, but we mirror the production setup.
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);
      await prisma.$executeRawUnsafe(`ALTER TABLE public."task_run_v2" REPLICA IDENTITY FULL;`);

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
        flushBatchSize: 1,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        ackIntervalSeconds: 5,
        tracer,
        logLevel: "warn",
      });

      await runsReplicationService.start();

      try {
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

        // A v2 run lives in task_run_v2, keyed by a KSUID id.
        const ksuid = RunId.generateKsuid();
        const run = await prisma.taskRunV2.create({
          data: {
            id: ksuid.id,
            friendlyId: ksuid.friendlyId,
            taskIdentifier: "my-task",
            payload: JSON.stringify({ foo: "bar" }),
            payloadType: "application/json",
            traceId: "v2trace",
            spanId: "v2span",
            queue: "test",
            workerQueue: "us-east-1-next",
            region: "us-east-1",
            planType: "free",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
          },
        });

        const queryRuns = clickhouse.reader.query({
          name: "runs-replication",
          query: "SELECT * FROM trigger_dev.task_runs_v2 WHERE run_id = {runId: String}",
          schema: z.any(),
          params: z.object({ runId: z.string() }),
        });

        // ClickHouse replication is asynchronous: poll until the row lands
        // (bounded) instead of a fixed sleep, which is flaky under lag variance.
        let queryError: unknown = null;
        let result: Array<Record<string, unknown>> | undefined;
        const deadline = Date.now() + 10_000;
        do {
          [queryError, result] = await queryRuns({ runId: run.id });
          if (!queryError && result?.length === 1) break;
          await setTimeout(200);
        } while (Date.now() < deadline);

        expect(queryError).toBeNull();
        expect(result?.length).toBe(1);
        expect(result?.[0]).toEqual(
          expect.objectContaining({
            run_id: run.id,
            friendly_id: run.friendlyId,
            task_identifier: "my-task",
            environment_id: runtimeEnvironment.id,
            project_id: project.id,
            organization_id: organization.id,
            environment_type: "DEVELOPMENT",
            engine: "V2",
          })
        );
      } finally {
        await runsReplicationService.stop();
      }
    }
  );

  replicationContainerTest(
    "streams a task_run_v2 DELETE with a complete old row (REPLICA IDENTITY FULL) so the tombstone carries org id",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);
      // The migration sets this in production; the testcontainer builds via
      // db push, so apply it here. Without FULL, the DELETE's old tuple is just
      // the PK and organization_id below would be empty (tombstone dropped).
      await prisma.$executeRawUnsafe(`ALTER TABLE public."task_run_v2" REPLICA IDENTITY FULL;`);

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
        flushBatchSize: 1,
        leaderLockTimeoutMs: 5000,
        leaderLockExtendIntervalMs: 1000,
        ackIntervalSeconds: 5,
        tracer,
        logLevel: "warn",
      });

      await runsReplicationService.start();

      try {
        const organization = await prisma.organization.create({
          data: { title: "test", slug: "test" },
        });
        const project = await prisma.project.create({
          data: { name: "test", slug: "test", organizationId: organization.id, externalRef: "test" },
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

        const ksuid = RunId.generateKsuid();
        const run = await prisma.taskRunV2.create({
          data: {
            id: ksuid.id,
            friendlyId: ksuid.friendlyId,
            taskIdentifier: "my-task",
            payload: "{}",
            payloadType: "application/json",
            traceId: "v2del",
            spanId: "v2del",
            queue: "test",
            workerQueue: "us-east-1-next",
            region: "us-east-1",
            planType: "free",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
          },
        });

        const latestRow = clickhouse.reader.query({
          name: "runs-replication",
          query:
            "SELECT run_id, organization_id, environment_id, _is_deleted FROM trigger_dev.task_runs_v2 WHERE run_id = {runId: String} ORDER BY _version DESC LIMIT 1",
          schema: z.any(),
          params: z.object({ runId: z.string() }),
        });

        // Wait for the INSERT to land.
        let result: Array<Record<string, unknown>> | undefined;
        let insertDeadline = Date.now() + 10_000;
        do {
          const [, rows] = await latestRow({ runId: run.id });
          result = rows;
          if (result?.length === 1 && Number(result[0]._is_deleted) === 0) break;
          await setTimeout(200);
        } while (Date.now() < insertDeadline);
        expect(result?.length).toBe(1);

        // Delete the v2 run and wait for the tombstone.
        await prisma.taskRunV2.delete({ where: { id: run.id } });

        const deleteDeadline = Date.now() + 10_000;
        do {
          const [, rows] = await latestRow({ runId: run.id });
          result = rows;
          if (result?.length === 1 && Number(result[0]._is_deleted) === 1) break;
          await setTimeout(200);
        } while (Date.now() < deleteDeadline);

        // The tombstone must carry the full old row (org/env), not just the PK.
        expect(Number(result?.[0]?._is_deleted)).toBe(1);
        expect(result?.[0]).toEqual(
          expect.objectContaining({
            run_id: run.id,
            organization_id: organization.id,
            environment_id: runtimeEnvironment.id,
          })
        );
      } finally {
        await runsReplicationService.stop();
      }
    }
  );
});
