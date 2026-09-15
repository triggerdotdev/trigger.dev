import { ClickHouse } from "@internal/clickhouse";
import { replicationContainerTest } from "@internal/testcontainers";
import { z } from "zod";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { TestReplicationClickhouseFactory } from "./utils/testReplicationClickhouseFactory";
import { createInMemoryTracing } from "./utils/tracing";

vi.setConfig({ testTimeout: 60_000 });

describe("RunsReplicationService external_deployment_id", () => {
  replicationContainerTest(
    "projects the external deployment id only for runs parked on it, including when the annotations blob fails RunAnnotations validation",
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

      const withId = await prisma.taskRun.create({
        data: {
          ...baseRun,
          friendlyId: "run_1234",
          traceId: "1234",
          spanId: "1234",
          status: "PENDING_VERSION",
          statusReason: "EXTERNAL_DEPLOYMENT_PENDING",
          annotations: {
            triggerSource: "sdk",
            triggerAction: "trigger",
            rootTriggerSource: "sdk",
            externalDeploymentId: "fa1eade47b73733d6312d5abfad33ce9e4068081",
          },
        },
      });

      const withoutId = await prisma.taskRun.create({
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

      const withUnparseableAnnotations = await prisma.taskRun.create({
        data: {
          ...baseRun,
          friendlyId: "run_1236",
          traceId: "1236",
          spanId: "1236",
          status: "PENDING_VERSION",
          statusReason: "EXTERNAL_DEPLOYMENT_PENDING",
          annotations: {
            triggerSource: "sdk",
            externalDeploymentId: "commit-on-a-broken-blob",
          },
        },
      });

      const reportedButParkedForAnotherReason = await prisma.taskRun.create({
        data: {
          ...baseRun,
          friendlyId: "run_1237",
          traceId: "1237",
          spanId: "1237",
          status: "PENDING_VERSION",
          statusReason: "NO_WORKER",
          annotations: {
            triggerSource: "sdk",
            triggerAction: "trigger",
            rootTriggerSource: "sdk",
            externalDeploymentId: "commit-reported-not-parked",
          },
        },
      });

      const queryRuns = clickhouse.reader.query({
        name: "runs-replication",
        query: "SELECT run_id, external_deployment_id FROM trigger_dev.task_runs_v2",
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

      const byRunId = new Map<string, string>(
        (rows ?? []).map((row: { run_id: string; external_deployment_id: string }) => [
          row.run_id,
          row.external_deployment_id,
        ])
      );

      expect(byRunId.get(withId.id)).toBe("fa1eade47b73733d6312d5abfad33ce9e4068081");
      expect(byRunId.get(withoutId.id)).toBe("");
      expect(byRunId.get(withUnparseableAnnotations.id)).toBe("commit-on-a-broken-blob");
      expect(byRunId.get(reportedButParkedForAnotherReason.id)).toBe("");

      await runsReplicationService.stop();
    }
  );
});
