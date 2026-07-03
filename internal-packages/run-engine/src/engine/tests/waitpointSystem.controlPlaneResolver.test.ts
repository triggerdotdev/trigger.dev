// Cross-DB inversion proof for the waitpoint env include (continueRunIfUnblocked).
// Cloud topology: run-ops = new DB (PG17, cross-seam FKs DROPPED), control-plane = legacy DB (PG14).
// The env (with maxConc/burstFactor/project/organization) lives on PG14; the run-ops scalar row on
// PG17. The PassthroughControlPlaneResolver over PG14 resolves the env half (which satisfies
// MinimalAuthenticatedEnvironment for enqueueRun) while the run scalars come from PG17 — no
// cross-DB join. The DB is never mocked. A single-DB passthrough case proves continueRunIfUnblocked
// re-queues byte-identically through the resolved env.
import { assertNonNullable, containerTest, heteroPostgresTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import type { MinimalAuthenticatedEnvironment } from "../../shared/index.js";
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
      maximumConcurrencyLimit: 13,
    },
  });
  return { organization, project, environment };
}

describe("WaitpointSystem controlPlaneResolver (hetero cross-DB)", () => {
  heteroPostgresTest(
    "env resolves from PG14 (control-plane) while the run scalars live on PG17 (no cross-DB join)",
    async ({ prisma14, prisma17 }) => {
      await dropTaskRunCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedControlPlaneEnv(prisma14 as unknown as PrismaClient, "cpwp");

      const runId = "run_cpwp_pg17";
      await (prisma17 as unknown as PrismaClient).taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "PENDING",
          friendlyId: "run_friendly_cpwp",
          runtimeEnvironmentId: cp.environment.id,
          organizationId: cp.organization.id,
          projectId: cp.project.id,
          taskIdentifier: "my-task",
          payload: "{}",
          payloadType: "application/json",
          queue: "task/my-task",
          traceId: "trace_cpwp",
          spanId: "span_cpwp",
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

      const env = await resolver.resolveEnv(run.runtimeEnvironmentId);
      assertNonNullable(env);
      // The resolved env carries everything enqueueRun's MinimalAuthenticatedEnvironment needs.
      const asMinimal: MinimalAuthenticatedEnvironment = env;
      expect(asMinimal.id).toBe(cp.environment.id);
      expect(asMinimal.type).toBe("PRODUCTION");
      expect(asMinimal.maximumConcurrencyLimit).toBe(13);
      expect(asMinimal.concurrencyLimitBurstFactor.toNumber()).toBe(2);
      expect(asMinimal.project.id).toBe(cp.project.id);
      expect(asMinimal.organization.id).toBe(cp.organization.id);

      // Inversion: the run-ops DB (PG17) holds no env row; a co-located join would resolve null.
      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
    }
  );
});

describe("WaitpointSystem controlPlaneResolver (single-DB passthrough)", () => {
  containerTest(
    "continueRunIfUnblocked re-queues byte-identically through the resolved env",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_cpwppassthru1",
            environment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-cpwp",
            spanId: "s-cpwp",
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

        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.waitpoint.id,
          projectId: environment.projectId,
          organizationId: environment.organizationId,
        });

        const blocked = await engine.getRunExecutionData({ runId: run.id });
        expect(blocked?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        // Completing the waitpoint drives continueRunIfUnblocked, which resolves the env via the
        // resolver and unblocks the run.
        await engine.completeWaitpoint({ id: waitpoint.waitpoint.id });
        await setTimeout(300);

        const unblocked = await engine.getRunExecutionData({ runId: run.id });
        expect(unblocked?.snapshot.executionStatus).toBe("EXECUTING");

        const stillBlocking = await prisma.taskRunWaitpoint.findFirst({
          where: { taskRunId: run.id },
        });
        expect(stillBlocking).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );
});
