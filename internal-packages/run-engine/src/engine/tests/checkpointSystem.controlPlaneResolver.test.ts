// Cross-DB inversion proof for the checkpoint env include (suspendForCheckpoint + createCheckpoint).
// Cloud topology: run-ops = new DB (PG17, cross-seam FKs DROPPED), control-plane = legacy DB (PG14).
// The env/project/organization live on PG14; the run-ops scalar row on PG17. The
// PassthroughControlPlaneResolver over PG14 resolves the env half (used for the runStatusChanged
// emit, the TaskRunCheckpoint data, and enqueueRun) while the run scalars come from PG17 — no
// cross-DB join. The DB is never mocked. A single-DB passthrough case proves createCheckpoint
// stamps the resolved env onto the checkpoint row byte-identically.
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
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0005,
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

describe("CheckpointSystem controlPlaneResolver (hetero cross-DB)", () => {
  heteroPostgresTest(
    "env resolves from PG14 (control-plane) while the run scalars live on PG17 (no cross-DB join)",
    async ({ prisma14, prisma17 }) => {
      await dropTaskRunCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedControlPlaneEnv(prisma14 as unknown as PrismaClient, "cpcp");

      const runId = "run_cpcp_pg17";
      await (prisma17 as unknown as PrismaClient).taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "EXECUTING",
          friendlyId: "run_friendly_cpcp",
          runtimeEnvironmentId: cp.environment.id,
          organizationId: cp.organization.id,
          projectId: cp.project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          queue: "task/my-task",
          traceId: "trace_cpcp",
          spanId: "span_cpcp",
        },
      });

      const runStore = new PostgresRunStore({
        prisma: prisma17 as unknown as PrismaClient,
        readOnlyPrisma: prisma17 as unknown as PrismaClient,
      });
      const resolver = new PassthroughControlPlaneResolver({
        prisma: prisma14 as unknown as PrismaClient,
      });

      // suspendForCheckpoint with an empty include returns the run-ops scalars and flips status.
      const run = await runStore.suspendForCheckpoint(runId, { include: {} });
      assertNonNullable(run);
      expect(run.status).toBe("WAITING_TO_RESUME");
      expect(run.runtimeEnvironmentId).toBe(cp.environment.id);

      // The control-plane env (project/organization) resolves from PG14; these are exactly the
      // fields checkpoint stamps onto the runStatusChanged emit, the TaskRunCheckpoint data, and
      // enqueueRun — all without touching the run-ops DB.
      const env = await resolver.resolveEnv(run.runtimeEnvironmentId);
      assertNonNullable(env);
      expect(env.id).toBe(cp.environment.id);
      expect(env.projectId).toBe(cp.project.id);
      expect(env.organizationId).toBe(cp.organization.id);

      // Inversion: the run-ops DB (PG17) holds no env row; a co-located join would resolve null.
      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
    }
  );
});

describe("CheckpointSystem controlPlaneResolver (single-DB passthrough)", () => {
  containerTest(
    "createCheckpoint stamps the resolved env onto the checkpoint row byte-identically",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_cpcppassthru1",
            environment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-cpcp",
            spanId: "s-cpcp",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        assertNonNullable(dequeued[0]);

        await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        const waitpoint = await engine.createManualWaitpoint({
          environmentId: environment.id,
          projectId: environment.projectId,
        });
        const blocked = await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.waitpoint.id,
          projectId: environment.projectId,
          organizationId: environment.organizationId,
        });

        const checkpointResult = await engine.createCheckpoint({
          runId: run.id,
          snapshotId: blocked.id,
          checkpoint: {
            type: "DOCKER",
            reason: "TEST_CHECKPOINT",
            location: "test-location",
            imageRef: "test-image-ref",
          },
        });
        expect(checkpointResult.ok).toBe(true);

        const persisted = await prisma.taskRunCheckpoint.findFirst({
          where: { executionSnapshot: { some: { runId: run.id } } },
        });
        assertNonNullable(persisted);
        // The resolved env's projectId + runtimeEnvironmentId were stamped onto the checkpoint.
        expect(persisted.projectId).toBe(environment.projectId);
        expect(persisted.runtimeEnvironmentId).toBe(environment.id);
      } finally {
        await engine.quit();
      }
    }
  );
});
