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

describe("RunsReplicationService (part 7/7)", () => {
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
