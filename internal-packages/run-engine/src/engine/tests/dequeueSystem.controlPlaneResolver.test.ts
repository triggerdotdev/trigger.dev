// Cross-DB inversion proof for the dequeue control-plane join (#getRunWithBackgroundWorkerTasks).
// Cloud topology: run-ops = the new DB (PG17, cross-seam FKs DROPPED), control-plane = the legacy
// DB (PG14, FKs retained). The env + worker version (deployment/tasks/queues) live on PG14; the
// run-ops scalar row lives on PG17 with no env/worker present. The PassthroughControlPlaneResolver
// over PG14 resolves the control-plane half while the PostgresRunStore over PG17 resolves the run
// scalars — proving the two halves resolve from separate providers with NO cross-DB join. The DB
// is never mocked. A single-DB passthrough case proves the engine dequeue is byte-identical.
import { assertNonNullable, containerTest, heteroPostgresTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { DequeuedMessage } from "@trigger.dev/core/v3";
import {
  CURRENT_DEPLOYMENT_LABEL,
  generateFriendlyId,
  sanitizeQueueName,
} from "@trigger.dev/core/v3/isomorphic";
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
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

/**
 * Seed a control-plane env + a promoted MANAGED deployment with worker/tasks/queues directly on a
 * client (no engine), so the control-plane half can live on a DISTINCT provider from the run-ops
 * row. Mirrors setup.ts's PRODUCTION deployment path.
 */
async function seedControlPlane(prisma: PrismaClient, suffix: string, taskSlug: string) {
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
      maximumConcurrencyLimit: 10,
    },
  });

  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: generateFriendlyId("worker"),
      contentHash: "hash",
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
      version: "20240101.1",
      metadata: {},
      engine: "V2",
    },
  });

  const task = await prisma.backgroundWorkerTask.create({
    data: {
      friendlyId: generateFriendlyId("task"),
      slug: taskSlug,
      filePath: `/trigger/${taskSlug}.ts`,
      exportName: taskSlug,
      workerId: worker.id,
      runtimeEnvironmentId: environment.id,
      projectId: project.id,
      retryConfig: { maxAttempts: 3, factor: 1, minTimeoutInMs: 100, maxTimeoutInMs: 100 },
    },
  });

  const queueName = sanitizeQueueName(`task/${taskSlug}`);
  const queue = await prisma.taskQueue.create({
    data: {
      friendlyId: generateFriendlyId("queue"),
      name: queueName,
      concurrencyLimit: 10,
      runtimeEnvironmentId: environment.id,
      projectId: project.id,
      type: "VIRTUAL",
      workers: { connect: { id: worker.id } },
      tasks: { connect: { id: task.id } },
    },
  });

  const deployment = await prisma.workerDeployment.create({
    data: {
      friendlyId: generateFriendlyId("deployment"),
      contentHash: worker.contentHash,
      version: worker.version,
      shortCode: `short_code_${worker.version}`,
      imageReference: `trigger/${project.externalRef}:${worker.version}.${environment.slug}`,
      status: "DEPLOYED",
      projectId: project.id,
      environmentId: environment.id,
      workerId: worker.id,
      type: "MANAGED",
    },
  });

  await prisma.workerDeploymentPromotion.create({
    data: {
      deploymentId: deployment.id,
      environmentId: environment.id,
      label: CURRENT_DEPLOYMENT_LABEL,
    },
  });

  return { organization, project, environment, worker, task, queue, deployment, queueName };
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

describe("DequeueSystem controlPlaneResolver (hetero cross-DB)", () => {
  heteroPostgresTest(
    "env + worker version resolve from PG14 while the run scalars resolve from PG17 (no cross-DB join)",
    async ({ prisma14, prisma17 }) => {
      const taskSlug = "test-task";
      // Cloud shape: drop the run-ops -> control-plane Cascade FKs on the run-ops (new) DB only.
      await dropTaskRunCrossSeamFks(prisma17 as unknown as PrismaClient);

      const cp = await seedControlPlane(prisma14 as unknown as PrismaClient, "cpdq", taskSlug);

      // The run-ops row lives ONLY on PG17, which holds NO env/worker/deployment rows, so any
      // in-DB join against PG17 would resolve null — the resolver against PG14 is the only path.
      const runId = "run_cpdq_pg17";
      await (prisma17 as unknown as PrismaClient).taskRun.create({
        data: {
          id: runId,
          engine: "V2",
          status: "PENDING",
          friendlyId: `run_friendly_cpdq`,
          runtimeEnvironmentId: cp.environment.id,
          organizationId: cp.organization.id,
          projectId: cp.project.id,
          taskIdentifier: taskSlug,
          payload: "{}",
          payloadType: "application/json",
          queue: cp.queueName,
          traceId: "trace_cpdq",
          spanId: "span_cpdq",
        },
      });

      const runStore = new PostgresRunStore({
        prisma: prisma17 as unknown as PrismaClient,
        readOnlyPrisma: prisma17 as unknown as PrismaClient,
      });
      const resolver = new PassthroughControlPlaneResolver({
        prisma: prisma14 as unknown as PrismaClient,
      });

      // Run-ops scalars resolve from PG17.
      const run = await runStore.findRun(
        { id: runId },
        {
          select: {
            id: true,
            taskIdentifier: true,
            runtimeEnvironmentId: true,
            queue: true,
          },
        }
      );
      assertNonNullable(run);
      expect(run.id).toBe(runId);
      expect(run.runtimeEnvironmentId).toBe(cp.environment.id);

      // The control-plane env resolves from PG14.
      const env = await resolver.resolveEnv(run.runtimeEnvironmentId);
      assertNonNullable(env);
      expect(env.id).toBe(cp.environment.id);
      expect(env.type).toBe("PRODUCTION");

      // The worker version (promoted MANAGED deployment + tasks + queues) resolves from PG14.
      const version = await resolver.resolveWorkerVersion({
        environmentId: run.runtimeEnvironmentId,
        type: env.type,
      });
      assertNonNullable(version);
      expect(version.worker.id).toBe(cp.worker.id);
      expect(version.deployment?.id).toBe(cp.deployment.id);
      expect(version.tasks.find((t) => t.slug === run.taskIdentifier)?.id).toBe(cp.task.id);
      expect(version.queues.find((q) => q.name === run.queue)?.id).toBe(cp.queue.id);

      // Proof of inversion: the run-ops DB (PG17) has no env/worker rows; a co-located join on
      // PG17 would have resolved null. The run row is absent from the control-plane DB (PG14).
      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
      expect(await (prisma17 as unknown as PrismaClient).backgroundWorker.count()).toBe(0);
      expect(await (prisma14 as unknown as PrismaClient).taskRun.count()).toBe(0);
    }
  );
});

describe("DequeueSystem controlPlaneResolver (latest-v2 fallback + workerId branches)", () => {
  // Deployed + no workerId, where the CURRENT-promoted deployment is NOT MANAGED.
  // #getManagedWorkerFromCurrentlyPromotedDeployment must fall back to the latest MANAGED
  // WorkerDeployment for the env (controlPlaneResolver.ts ~line 244). Every other test promotes a
  // MANAGED deployment, so this fallback branch was previously unexercised.
  containerTest(
    "resolveWorkerVersion (deployed, no workerId) falls back to the latest MANAGED deployment when the promoted one is not MANAGED",
    async ({ prisma }) => {
      const taskSlug = "test-task";

      const organization = await prisma.organization.create({
        data: { title: "Org fallback", slug: "org-fallback" },
      });
      const project = await prisma.project.create({
        data: {
          name: "Project fallback",
          slug: "project-fallback",
          externalRef: "proj_fallback",
          organizationId: organization.id,
        },
      });
      const environment = await prisma.runtimeEnvironment.create({
        data: {
          type: "PRODUCTION",
          slug: "prod-fallback",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "tr_prod_fallback",
          pkApiKey: "pk_prod_fallback",
          shortcode: "short_fallback",
          maximumConcurrencyLimit: 10,
        },
      });

      // The CURRENT-promoted deployment is a NON-MANAGED (V1) deployment with its own worker.
      const promotedWorker = await prisma.backgroundWorker.create({
        data: {
          friendlyId: generateFriendlyId("worker"),
          contentHash: "hash-v1",
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          version: "20240101.1",
          metadata: {},
          engine: "V1",
        },
      });
      const promotedDeployment = await prisma.workerDeployment.create({
        data: {
          friendlyId: generateFriendlyId("deployment"),
          contentHash: promotedWorker.contentHash,
          version: promotedWorker.version,
          shortCode: "short_code_v1",
          imageReference: `trigger/${project.externalRef}:v1.${environment.slug}`,
          status: "DEPLOYED",
          projectId: project.id,
          environmentId: environment.id,
          workerId: promotedWorker.id,
          type: "V1",
        },
      });
      await prisma.workerDeploymentPromotion.create({
        data: {
          deploymentId: promotedDeployment.id,
          environmentId: environment.id,
          label: CURRENT_DEPLOYMENT_LABEL,
        },
      });

      // A SEPARATE, later (higher id) MANAGED deployment + worker with tasks/queues. This is the
      // latest-v2 deployment the fallback must select.
      const managedWorker = await prisma.backgroundWorker.create({
        data: {
          friendlyId: generateFriendlyId("worker"),
          contentHash: "hash-managed",
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          version: "20240101.2",
          metadata: {},
          engine: "V2",
        },
      });
      const managedTask = await prisma.backgroundWorkerTask.create({
        data: {
          friendlyId: generateFriendlyId("task"),
          slug: taskSlug,
          filePath: `/trigger/${taskSlug}.ts`,
          exportName: taskSlug,
          workerId: managedWorker.id,
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
          retryConfig: { maxAttempts: 3, factor: 1, minTimeoutInMs: 100, maxTimeoutInMs: 100 },
        },
      });
      const managedQueueName = sanitizeQueueName(`task/${taskSlug}`);
      const managedQueue = await prisma.taskQueue.create({
        data: {
          friendlyId: generateFriendlyId("queue"),
          name: managedQueueName,
          concurrencyLimit: 10,
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
          type: "VIRTUAL",
          workers: { connect: { id: managedWorker.id } },
          tasks: { connect: { id: managedTask.id } },
        },
      });
      const managedDeployment = await prisma.workerDeployment.create({
        data: {
          friendlyId: generateFriendlyId("deployment"),
          contentHash: managedWorker.contentHash,
          version: managedWorker.version,
          shortCode: "short_code_managed",
          imageReference: `trigger/${project.externalRef}:managed.${environment.slug}`,
          status: "DEPLOYED",
          projectId: project.id,
          environmentId: environment.id,
          workerId: managedWorker.id,
          type: "MANAGED",
        },
      });

      const resolver = new PassthroughControlPlaneResolver({
        prisma: prisma as unknown as PrismaClient,
      });

      const version = await resolver.resolveWorkerVersion({
        environmentId: environment.id,
        type: "PRODUCTION",
      });

      assertNonNullable(version);
      // The fallback selects the MANAGED deployment/worker, NOT the promoted non-MANAGED one.
      expect(version.worker.id).toBe(managedWorker.id);
      expect(version.worker.id).not.toBe(promotedWorker.id);
      expect(version.deployment?.id).toBe(managedDeployment.id);
      expect(version.deployment?.id).not.toBe(promotedDeployment.id);
      // Tasks/queues come from the MANAGED worker.
      expect(version.tasks.find((t) => t.slug === taskSlug)?.id).toBe(managedTask.id);
      expect(version.queues.find((q) => q.name === managedQueueName)?.id).toBe(managedQueue.id);
    }
  );

  // The dequeue hot path computes `workerId = run.lockedToVersionId ?? backgroundWorkerId`
  // and passes it to resolveWorkerVersion. A locked-to-version run exercises the workerId branches,
  // which no other test covers.
  containerTest(
    "resolveWorkerVersion (deployed, with workerId) returns that exact worker + deployment",
    async ({ prisma }) => {
      const taskSlug = "test-task";
      const cp = await seedControlPlane(prisma as unknown as PrismaClient, "wid", taskSlug);

      const resolver = new PassthroughControlPlaneResolver({
        prisma: prisma as unknown as PrismaClient,
      });

      // Covers #getWorkerDeploymentFromWorker.
      const version = await resolver.resolveWorkerVersion({
        environmentId: cp.environment.id,
        type: "PRODUCTION",
        workerId: cp.worker.id,
      });

      assertNonNullable(version);
      expect(version.worker.id).toBe(cp.worker.id);
      expect(version.deployment?.id).toBe(cp.deployment.id);
      expect(version.tasks.find((t) => t.slug === taskSlug)?.id).toBe(cp.task.id);
      expect(version.queues.find((q) => q.name === cp.queueName)?.id).toBe(cp.queue.id);
    }
  );

  containerTest(
    "resolveWorkerVersion (DEVELOPMENT, with workerId) returns that worker with deployment populated",
    async ({ prisma }) => {
      const organization = await prisma.organization.create({
        data: { title: "Org dev wid", slug: "org-dev-wid" },
      });
      const project = await prisma.project.create({
        data: {
          name: "Project dev wid",
          slug: "project-dev-wid",
          externalRef: "proj_dev_wid",
          organizationId: organization.id,
        },
      });
      const devEnv = await prisma.runtimeEnvironment.create({
        data: {
          type: "DEVELOPMENT",
          slug: "dev-wid",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: "tr_dev_wid",
          pkApiKey: "pk_dev_wid",
          shortcode: "short_dev_wid",
          maximumConcurrencyLimit: 10,
        },
      });

      const devWorker = await prisma.backgroundWorker.create({
        data: {
          friendlyId: generateFriendlyId("worker"),
          contentHash: "hash-dev",
          projectId: project.id,
          runtimeEnvironmentId: devEnv.id,
          version: "20240101.1",
          metadata: {},
          engine: "V2",
        },
      });
      const devDeployment = await prisma.workerDeployment.create({
        data: {
          friendlyId: generateFriendlyId("deployment"),
          contentHash: devWorker.contentHash,
          version: devWorker.version,
          shortCode: "short_code_dev",
          imageReference: `trigger/${project.externalRef}:dev.${devEnv.slug}`,
          status: "DEPLOYED",
          projectId: project.id,
          environmentId: devEnv.id,
          workerId: devWorker.id,
          type: "MANAGED",
        },
      });

      const resolver = new PassthroughControlPlaneResolver({
        prisma: prisma as unknown as PrismaClient,
      });

      // Covers #getWorkerById (which includes `deployment: true`).
      const version = await resolver.resolveWorkerVersion({
        environmentId: devEnv.id,
        type: "DEVELOPMENT",
        workerId: devWorker.id,
      });

      assertNonNullable(version);
      expect(version.worker.id).toBe(devWorker.id);
      expect(version.deployment?.id).toBe(devDeployment.id);
    }
  );
});

describe("DequeueSystem controlPlaneResolver (single-DB passthrough)", () => {
  containerTest(
    "default passthrough dequeue is byte-identical (resolves env + worker version end-to-end)",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        await engine.trigger(
          {
            number: 1,
            friendlyId: "run_cpdqpassthru1",
            environment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-cpdq",
            spanId: "s-cpdq",
            workerQueue: "main",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        await setTimeout(500);
        const dequeued: DequeuedMessage[] = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });

        expect(dequeued.length).toBe(1);
        assertNonNullable(dequeued[0]);
        // The resolved env + worker version flow into the message exactly as before.
        expect(dequeued[0].environment.id).toBe(environment.id);
        expect(dequeued[0].environment.type).toBe("PRODUCTION");
        expect(dequeued[0].run.id).toBeDefined();
        expect(dequeued[0].backgroundWorker.id).toBeDefined();
        expect(dequeued[0].image).toBeDefined();
      } finally {
        await engine.quit();
      }
    }
  );
});
