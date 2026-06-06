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

describe("RunsReplicationService (part 5/6)", () => {
  replicationContainerTest(
    "should replicate all events in a single transaction (insert, update)",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-multi-event-tx",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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

  replicationContainerTest(
    "should be able to handle processing transactions for a long period of time",
    { timeout: 60_000 * 5 },
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication-long-tx",
        logLevel: "warn",
      });

      const runsReplicationService = new RunsReplicationService({
        clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
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
    }
  );

});
