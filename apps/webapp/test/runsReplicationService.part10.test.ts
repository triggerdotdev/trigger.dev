import { ClickHouse } from "@internal/clickhouse";
import { replicationContainerTest } from "@internal/testcontainers";
import { z } from "zod";
import { RunsReplicationService } from "~/services/runsReplicationService.server";
import { TestReplicationClickhouseFactory } from "./utils/testReplicationClickhouseFactory";
import { createInMemoryTracing } from "./utils/tracing";

vi.setConfig({ testTimeout: 60_000 });

function deeplyNested(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: 1 };
  for (let i = 0; i < depth; i++) {
    node = { [`k${i}`]: node };
  }
  return node;
}

describe("RunsReplicationService (part 10/10) — JSON parse recovery", () => {
  replicationContainerTest(
    "lands the good runs when one run in the batch has ClickHouse-unparseable JSON output",
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
        flushIntervalMs: 500,
        flushBatchSize: 50,
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

      const goodRunIds: string[] = [];
      let poisonRunId = "";

      for (let i = 0; i < 5; i++) {
        const isPoison = i === 2;
        const output = isPoison
          ? JSON.stringify(deeplyNested(1500))
          : JSON.stringify({ ok: true, i });

        const run = await prisma.taskRun.create({
          data: {
            friendlyId: `run_batchdrop_${i}`,
            taskIdentifier: "my-task",
            payload: JSON.stringify({ i }),
            payloadType: "application/json",
            output,
            outputType: "application/json",
            traceId: `trace_${i}`,
            spanId: `span_${i}`,
            queue: "test",
            status: "COMPLETED_SUCCESSFULLY",
            runtimeEnvironmentId: runtimeEnvironment.id,
            projectId: project.id,
            organizationId: organization.id,
            environmentType: "DEVELOPMENT",
            engine: "V2",
          },
        });

        if (isPoison) {
          poisonRunId = run.id;
        } else {
          goodRunIds.push(run.id);
        }
      }

      const queryRuns = clickhouse.reader.query({
        name: "runs-replication-batchdrop",
        query:
          "SELECT run_id FROM trigger_dev.task_runs_v2 WHERE organization_id = {org_id:String}",
        schema: z.object({ run_id: z.string() }),
        params: z.object({ org_id: z.string() }),
      });

      const landedIds = await vi.waitFor(
        async () => {
          const [queryError, rows] = await queryRuns({ org_id: organization.id });
          expect(queryError).toBeNull();
          const ids = new Set((rows ?? []).map((r) => r.run_id));
          for (const id of goodRunIds) {
            expect(ids.has(id)).toBe(true);
          }
          return ids;
        },
        { timeout: 30_000, interval: 250 }
      );

      for (const id of goodRunIds) {
        expect(landedIds.has(id)).toBe(true);
      }
      expect(landedIds.has(poisonRunId)).toBe(false);

      expect(runsReplicationService.permanentlyDroppedBatches).toBe(0);
      expect(runsReplicationService.rowIsolationRecoveries).toBeGreaterThanOrEqual(1);

      await runsReplicationService.stop();
    }
  );
});
