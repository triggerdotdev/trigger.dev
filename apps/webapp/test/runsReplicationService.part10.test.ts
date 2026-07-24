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

function createService(
  clickhouse: ClickHouse,
  postgresUrl: string,
  redisOptions: any,
  flushIntervalMs = 500
) {
  const { tracer } = createInMemoryTracing();
  return new RunsReplicationService({
    clickhouseFactory: new TestReplicationClickhouseFactory(clickhouse),
    pgConnectionUrl: postgresUrl,
    serviceName: "runs-replication",
    slotName: "task_runs_to_clickhouse_v1",
    publicationName: "task_runs_to_clickhouse_v1_publication",
    redisOptions,
    maxFlushConcurrency: 1,
    flushIntervalMs,
    flushBatchSize: 50,
    leaderLockTimeoutMs: 5000,
    leaderLockExtendIntervalMs: 1000,
    ackIntervalSeconds: 5,
    tracer,
    logLevel: "warn",
  });
}

async function setupProject(prisma: any) {
  const organization = await prisma.organization.create({ data: { title: "test", slug: "test" } });
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
  return { organization, project, runtimeEnvironment };
}

async function createRun(
  prisma: any,
  ctx: { organization: any; project: any; runtimeEnvironment: any },
  i: number,
  isPoison: boolean
) {
  return prisma.taskRun.create({
    data: {
      friendlyId: `run_batchdrop_${i}`,
      taskIdentifier: "my-task",
      payload: JSON.stringify({ i }),
      payloadType: "application/json",
      output: isPoison ? JSON.stringify(deeplyNested(1500)) : JSON.stringify({ ok: true, i }),
      outputType: "application/json",
      traceId: `trace_${i}`,
      spanId: `span_${i}`,
      queue: "test",
      status: "COMPLETED_SUCCESSFULLY",
      runtimeEnvironmentId: ctx.runtimeEnvironment.id,
      projectId: ctx.project.id,
      organizationId: ctx.organization.id,
      environmentType: "DEVELOPMENT",
      engine: "V2",
    },
  });
}

describe("RunsReplicationService (part 10/10) — JSON parse recovery", () => {
  replicationContainerTest(
    "strips a single poison run and lands every run (poison run keeps its status, output stripped)",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
        compression: { request: true },
        logLevel: "warn",
      });

      const runsReplicationService = createService(
        clickhouse,
        postgresContainer.getConnectionUri(),
        redisOptions
      );
      await runsReplicationService.start();

      const ctx = await setupProject(prisma);

      const goodRunIds: string[] = [];
      let poisonRunId = "";
      for (let i = 0; i < 5; i++) {
        const isPoison = i === 2;
        const run = await createRun(prisma, ctx, i, isPoison);
        if (isPoison) poisonRunId = run.id;
        else goodRunIds.push(run.id);
      }

      const queryRuns = clickhouse.reader.query({
        name: "runs-replication-batchdrop",
        query:
          "SELECT run_id, status, toJSONString(output) AS output_json FROM trigger_dev.task_runs_v2 FINAL WHERE organization_id = {org_id:String}",
        schema: z.object({ run_id: z.string(), status: z.string(), output_json: z.string() }),
        params: z.object({ org_id: z.string() }),
      });

      const rowsById = await vi.waitFor(
        async () => {
          const [queryError, rows] = await queryRuns({ org_id: ctx.organization.id });
          expect(queryError).toBeNull();
          const byId = new Map((rows ?? []).map((r) => [r.run_id, r]));
          for (const id of [...goodRunIds, poisonRunId]) {
            expect(byId.has(id)).toBe(true);
          }
          return byId;
        },
        { timeout: 30_000, interval: 250 }
      );

      for (const id of goodRunIds) {
        expect(rowsById.get(id)!.output_json).toContain('"ok":true');
      }

      const poison = rowsById.get(poisonRunId)!;
      expect(poison.status).toBe("COMPLETED_SUCCESSFULLY");
      expect(poison.output_json).toBe("{}");

      expect(runsReplicationService.permanentlyDroppedBatches).toBe(0);
      expect(runsReplicationService.permanentlyDroppedRows).toBe(0);
      expect(runsReplicationService.recoveryCapHits).toBe(0);
      expect(runsReplicationService.rowIsolationRecoveries).toBeGreaterThanOrEqual(1);
      expect(runsReplicationService.rowsStripped).toBeGreaterThanOrEqual(1);

      await runsReplicationService.stop();
    }
  );

  replicationContainerTest(
    "strips up to the limit then skips the excess poison via allow_errors (2 poison, limit 1)",
    async ({ clickhouseContainer, redisOptions, postgresContainer, prisma }) => {
      await prisma.$executeRawUnsafe(`ALTER TABLE public."TaskRun" REPLICA IDENTITY FULL;`);

      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "runs-replication",
        compression: { request: true },
        logLevel: "warn",
      });

      const runsReplicationService = createService(
        clickhouse,
        postgresContainer.getConnectionUri(),
        redisOptions,
        3000
      );
      await runsReplicationService.start();

      const ctx = await setupProject(prisma);

      const goodRunIds: string[] = [];
      const poisonRunIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const isPoison = i === 1 || i === 3;
        const run = await createRun(prisma, ctx, i, isPoison);
        if (isPoison) poisonRunIds.push(run.id);
        else goodRunIds.push(run.id);
      }

      const queryRuns = clickhouse.reader.query({
        name: "runs-replication-bail",
        query:
          "SELECT run_id, status, toJSONString(output) AS output_json FROM trigger_dev.task_runs_v2 FINAL WHERE organization_id = {org_id:String}",
        schema: z.object({ run_id: z.string(), status: z.string(), output_json: z.string() }),
        params: z.object({ org_id: z.string() }),
      });

      const rowsById = await vi.waitFor(
        async () => {
          const [queryError, rows] = await queryRuns({ org_id: ctx.organization.id });
          expect(queryError).toBeNull();
          const byId = new Map((rows ?? []).map((r) => [r.run_id, r]));
          for (const id of goodRunIds) {
            expect(byId.has(id)).toBe(true);
          }
          expect(runsReplicationService.recoveryCapHits).toBeGreaterThanOrEqual(1);
          return byId;
        },
        { timeout: 30_000, interval: 250 }
      );

      for (const id of goodRunIds) {
        expect(rowsById.get(id)!.output_json).toContain('"ok":true');
      }

      const landedPoison = poisonRunIds.filter((id) => rowsById.has(id));
      expect(landedPoison).toHaveLength(1);
      const strippedPoison = rowsById.get(landedPoison[0]!)!;
      expect(strippedPoison.status).toBe("COMPLETED_SUCCESSFULLY");
      expect(strippedPoison.output_json).toBe("{}");

      expect(runsReplicationService.permanentlyDroppedBatches).toBe(0);
      expect(runsReplicationService.rowsStripped).toBeGreaterThanOrEqual(1);
      expect(runsReplicationService.recoveryCapHits).toBeGreaterThanOrEqual(1);

      await runsReplicationService.stop();
    }
  );
});
