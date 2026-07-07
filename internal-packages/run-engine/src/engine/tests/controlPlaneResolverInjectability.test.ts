import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Prisma } from "@trigger.dev/database";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import {
  PassthroughControlPlaneResolver,
  type ControlPlaneResolver,
  type ResolvedAuthenticatedEnv,
  type ResolvedEngineEnv,
  type ResolvedWorkerVersion,
} from "../controlPlaneResolver.js";
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

describe("RunEngine controlPlaneResolver injectability", () => {
  containerTest(
    "defaults to a PassthroughControlPlaneResolver when none is injected",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        expect(engine.controlPlaneResolver).toBeDefined();
        expect(engine.controlPlaneResolver).toBeInstanceOf(PassthroughControlPlaneResolver);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "the default passthrough resolves env, worker version, and env existence",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const setup = await setupBackgroundWorker(engine, environment, "test-task");

        // resolveEnv returns the seeded env with the flat + nested + concurrency fields.
        const env = await engine.controlPlaneResolver.resolveEnv(environment.id);
        expect(env).not.toBeNull();
        expect(env!.id).toBe(environment.id);
        expect(env!.type).toBe("PRODUCTION");
        expect(env!.projectId).toBe(environment.projectId);
        expect(env!.organizationId).toBe(environment.organizationId);
        expect(env!.project.id).toBe(environment.projectId);
        expect(env!.organization.id).toBe(environment.organizationId);
        expect(env!.maximumConcurrencyLimit).toBe(10);
        expect(env!.concurrencyLimitBurstFactor.toNumber()).toBe(2);
        expect(env!.archivedAt).toBeNull();

        // resolveWorkerVersion (no workerId, deployed env) returns the promoted deployment's worker.
        const version = await engine.controlPlaneResolver.resolveWorkerVersion({
          environmentId: environment.id,
          type: "PRODUCTION",
        });
        expect(version).not.toBeNull();
        expect(version!.worker.id).toBe(setup.worker.id);
        expect(version!.tasks.map((t) => t.slug)).toContain("test-task");
        expect(version!.queues.length).toBeGreaterThan(0);
        expect(version!.deployment?.id).toBe(
          "deployment" in setup ? setup.deployment.id : undefined
        );

        // The default passthrough resolver is single-DB, so assertEnvExists is a no-op:
        // it resolves for both a present and a missing env (nothing to assert).
        await expect(
          engine.controlPlaneResolver.assertEnvExists(environment.id)
        ).resolves.toBeUndefined();
        await expect(
          engine.controlPlaneResolver.assertEnvExists("env_does_not_exist")
        ).resolves.toBeUndefined();
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "the default passthrough resolveAuthenticatedEnv returns the slim env + git, null for a missing id",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        const env = await engine.controlPlaneResolver.resolveAuthenticatedEnv(environment.id);
        expect(env).not.toBeNull();
        expect(env!.id).toBe(environment.id);
        expect(env!.slug).toBe(environment.slug);
        expect(env!.type).toBe("PRODUCTION");
        expect(env!.organizationId).toBe(environment.organizationId);
        expect(env!.projectId).toBe(environment.projectId);
        expect(env!.branchName).toBeNull();
        expect(env!.git).toBeNull();
        expect(env!.project.id).toBe(environment.projectId);
        expect(env!.project.organizationId).toBe(environment.organizationId);
        expect(env!.organization.id).toBe(environment.organizationId);
        // concurrencyLimitBurstFactor is coerced to a plain number by the mapping.
        expect(typeof env!.concurrencyLimitBurstFactor).toBe("number");

        const missing = await engine.controlPlaneResolver.resolveAuthenticatedEnv("env_nope");
        expect(missing).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "uses an explicitly injected resolver as-is, visible to systems via this.$",
    async ({ prisma, redisOptions }) => {
      const sentinelEnv: ResolvedEngineEnv = {
        id: "env_sentinel",
        type: "PRODUCTION",
        archivedAt: null,
        maximumConcurrencyLimit: 7,
        concurrencyLimitBurstFactor: new Prisma.Decimal(3),
        projectId: "proj_sentinel",
        organizationId: "org_sentinel",
        project: { id: "proj_sentinel" },
        organization: { id: "org_sentinel" },
      };

      const sentinel: ControlPlaneResolver = {
        async resolveEnv(): Promise<ResolvedEngineEnv | null> {
          return sentinelEnv;
        },
        async resolveAuthenticatedEnv(): Promise<ResolvedAuthenticatedEnv | null> {
          return null;
        },
        async resolveWorkerVersion(): Promise<ResolvedWorkerVersion | null> {
          return null;
        },
        async assertEnvExists(): Promise<void> {},
      };

      const engine = new RunEngine({
        ...createEngineOptions(redisOptions, prisma),
        controlPlaneResolver: sentinel,
      });

      try {
        // The engine holds exactly the injected instance...
        expect(engine.controlPlaneResolver).toBe(sentinel);
        // ...and the systems received it via the shared SystemResources (this.$).
        expect((engine.dequeueSystem as any).$.controlPlaneResolver).toBe(sentinel);
        expect((engine.waitpointSystem as any).$.controlPlaneResolver).toBe(sentinel);

        const resolved = await engine.controlPlaneResolver.resolveEnv("anything");
        expect(resolved).toBe(sentinelEnv);
      } finally {
        await engine.quit();
      }
    }
  );
});
