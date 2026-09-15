// Cross-DB inversion proof for the delayTTL env include (#enqueueDelayedRun).
// Cloud topology: run-ops = new DB (PG17, cross-seam FKs DROPPED), control-plane = legacy DB (PG14).
// The env/project/organization live on PG14; the run-ops scalar row on PG17. The
// PassthroughControlPlaneResolver over PG14 resolves the env half (used for enqueueRun + the
// runEnqueuedAfterDelay emit) while the run scalars come from PG17 — no cross-DB join. The DB is
// never mocked. A single-DB passthrough case proves a delayed run becomes QUEUED byte-identically.
import { assertNonNullable, containerTest, heteroPostgresTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import { PassthroughControlPlaneResolver } from "../controlPlaneResolver.js";
import { PostgresRunStore } from "@internal/run-store";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function createEngineOptions(redisOptions: any, prisma: any) {
  return {
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: { redis: redisOptions },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

const TASK_RUN_CROSS_SEAM_FKS = [
  "TaskRun_runtimeEnvironmentId_fkey",
  "TaskRun_projectId_fkey",
  "TaskRun_organizationId_fkey",
] as const;

async function dropTaskRunCrossSeamFks(prisma: PrismaClient) {
  for (const constraint of TASK_RUN_CROSS_SEAM_FKS) {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "TaskRun" DROP CONSTRAINT IF EXISTS "${constraint}"`
    );
  }
}

async function seedControlPlaneEnv(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `prod-${suffix}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { organization, project, environment };
}

describe("DelayedRunSystem controlPlaneResolver (hetero cross-DB)", () => {
  heteroPostgresTest(
    "env resolves from PG14 (control-plane) while the run scalars live on PG17 (no cross-DB join)",
    async ({ prisma14, prisma17 }) => {
      await dropTaskRunCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedControlPlaneEnv(prisma14 as unknown as PrismaClient, "cpdl");

      const runId = "run_cpdl_pg17";
      await (prisma17 as unknown as PrismaClient).taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "DELAYED",
          friendlyId: "run_friendly_cpdl",
          runtimeEnvironmentId: cp.environment.id,
          organizationId: cp.organization.id,
          projectId: cp.project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          queue: "task/my-task",
          traceId: "trace_cpdl",
          spanId: "span_cpdl",
        },
      });

      const runStore = new PostgresRunStore({
        prisma: prisma17 as unknown as PrismaClient,
        readOnlyPrisma: prisma17 as unknown as PrismaClient,
      });
      const resolver = new PassthroughControlPlaneResolver({
        prisma: prisma14 as unknown as PrismaClient,
      });

      const run = await runStore.findRun({ id: runId });
      assertNonNullable(run);
      expect(run.runtimeEnvironmentId).toBe(cp.environment.id);

      // The env resolves from PG14 — exactly the fields #enqueueDelayedRun reads (type for the DEV
      // TTL branch; organizationId/projectId for the runEnqueuedAfterDelay emit; the env object
      // for enqueueRun).
      const env = await resolver.resolveEnv(run.runtimeEnvironmentId);
      assertNonNullable(env);
      expect(env.type).toBe("PRODUCTION");
      expect(env.organizationId).toBe(cp.organization.id);
      expect(env.projectId).toBe(cp.project.id);

      // Inversion: the run-ops DB (PG17) holds no env row; a co-located join would resolve null.
      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
    }
  );
});

describe("DelayedRunSystem controlPlaneResolver (single-DB passthrough)", () => {
  containerTest(
    "a delayed run becomes QUEUED byte-identically through the resolved env",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_cpdlpassthru1",
            environment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-cpdl",
            spanId: "s-cpdl",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 500),
          },
          prisma
        );

        const delayed = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(delayed);
        expect(delayed.snapshot.executionStatus).toBe("DELAYED");

        await setTimeout(1_000);

        const queued = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(queued);
        expect(queued.snapshot.executionStatus).toBe("QUEUED");
      } finally {
        await engine.quit();
      }
    }
  );
});
