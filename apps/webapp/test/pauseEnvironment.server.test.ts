import { RunEngine } from "@internal/run-engine";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { EnvironmentPauseSource, type PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "ioredis";
import { describe, expect, onTestFinished, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

// test/setup.ts stubs the app's engine singleton to a no-op, which would make any
// assertion about the RunQueue limits vacuous. The tests that care about those limits
// swap in a real RunEngine built on their own Redis container via `useEngine`; the
// others keep the no-op.
const { engineHolder } = vi.hoisted(() => ({
  engineHolder: {
    current: { runQueue: { updateEnvConcurrencyLimits: async () => undefined } } as any,
  },
}));

vi.mock("~/v3/runEngine.server", () => ({
  engine: new Proxy({} as Record<string, any>, {
    get: (_target, prop) => {
      const value = engineHolder.current[prop as string];
      return typeof value === "function" ? value.bind(engineHolder.current) : value;
    },
  }),
}));

function useEngine(prisma: PrismaClient, redisOptions: RedisOptions) {
  const engine = new RunEngine({
    prisma,
    worker: { redis: redisOptions, disabled: true },
    queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });

  const previous = engineHolder.current;
  engineHolder.current = engine;
  onTestFinished(async () => {
    engineHolder.current = previous;
    await engine.quit();
  });

  return engine;
}

// The service's import chain reaches module-level singletons that throw at load
// time when REDIS_HOST/REDIS_PORT are unset (autoIncrementCounter via
// triggerTaskV1), so the env must point at the redis container BEFORE the
// module is imported. Hence dynamic imports; vitest runs each file in its own
// fork, so the env mutation cannot leak into other suites.
async function loadService(redisOptions: RedisOptions) {
  process.env.REDIS_HOST = redisOptions.host;
  process.env.REDIS_PORT = String(redisOptions.port);
  process.env.REDIS_TLS_DISABLED = "true";
  const [
    { PauseEnvironmentService },
    { FinalizeDeploymentService },
    { authIncludeBase, toAuthenticated },
  ] = await Promise.all([
    import("~/v3/services/pauseEnvironment.server"),
    import("~/v3/services/finalizeDeployment.server"),
    import("~/models/runtimeEnvironment.server"),
  ]);
  return { PauseEnvironmentService, FinalizeDeploymentService, authIncludeBase, toAuthenticated };
}

type Loaded = Awaited<ReturnType<typeof loadService>>;

async function authEnv(
  loaded: Loaded,
  prisma: PrismaClient,
  environmentId: string
): Promise<AuthenticatedEnvironment> {
  const row = await prisma.runtimeEnvironment.findFirstOrThrow({
    where: { id: environmentId },
    include: loaded.authIncludeBase,
  });
  return loaded.toAuthenticated(row);
}

async function seedProductionEnv(prisma: PrismaClient, maximumConcurrencyLimit?: number) {
  const { organization, project } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });

  if (maximumConcurrencyLimit !== undefined) {
    await prisma.runtimeEnvironment.update({
      where: { id: environment.id },
      data: { maximumConcurrencyLimit },
    });
  }

  return { organization, project, environment };
}

/** Runs a deploy through to DEPLOYED, the way the finalize deployment endpoint does. */
async function finalizeADeployment(
  loaded: Loaded,
  prisma: PrismaClient,
  environment: AuthenticatedEnvironment
) {
  const version = uniqueId("2026.01.01");
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: uniqueId("worker"),
      contentHash: uniqueId("hash"),
      projectId: environment.projectId,
      runtimeEnvironmentId: environment.id,
      version,
      metadata: {},
      engine: "V2",
    },
  });

  const deployment = await prisma.workerDeployment.create({
    data: {
      friendlyId: uniqueId("deployment"),
      contentHash: worker.contentHash,
      shortCode: uniqueId("short"),
      version,
      status: "DEPLOYING",
      imageReference: "registry.example.com/image:latest",
      projectId: environment.projectId,
      environmentId: environment.id,
      workerId: worker.id,
    },
  });

  const service = new loaded.FinalizeDeploymentService(prisma);
  await service.call(environment, deployment.friendlyId, { skipPromotion: true });
}

// Kept first in this file: the app's Redis-backed module singletons (the deploy path's
// project pub/sub, for one) bind to the first container this file touches.
describe("environment pause and the RunQueue env concurrency limit", () => {
  containerTest(
    "a finalized deployment does not resume a paused environment",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadService(redisOptions);
      const engine = useEngine(prisma, redisOptions);

      const paused = await seedProductionEnv(prisma, 17);
      const pausedEnv = await authEnv(loaded, prisma, paused.environment.id);

      const pauseResult = await new loaded.PauseEnvironmentService(prisma).call(
        pausedEnv,
        "paused"
      );
      expect(pauseResult).toEqual({ success: true, state: "paused" });
      expect(await engine.runQueue.getEnvConcurrencyLimit(pausedEnv)).toBe(0);

      // A deploy request authenticates first, so the deploy sees the env as it is now.
      await finalizeADeployment(loaded, prisma, await authEnv(loaded, prisma, pausedEnv.id));

      // The 0 limit is the only thing stopping dequeues, so a deploy must not push the
      // environment's real limit back into the queue while the env is still paused.
      expect(await engine.runQueue.getEnvConcurrencyLimit(pausedEnv)).toBe(0);
      const after = await prisma.runtimeEnvironment.findFirstOrThrow({
        where: { id: paused.environment.id },
      });
      expect(after.paused).toBe(true);

      // Control for the assertion above: the same deploy path DOES push the real limit for
      // a running environment, so a limit of 0 can't just mean "the push never happened".
      const running = await seedProductionEnv(prisma, 17);
      const runningEnv = await authEnv(loaded, prisma, running.environment.id);
      await finalizeADeployment(loaded, prisma, runningEnv);
      expect(await engine.runQueue.getEnvConcurrencyLimit(runningEnv)).toBe(17);
    }
  );

  containerTest("resuming restores the environment limit", async ({ prisma, redisOptions }) => {
    const loaded = await loadService(redisOptions);
    const engine = useEngine(prisma, redisOptions);

    const { environment } = await seedProductionEnv(prisma, 17);
    const service = new loaded.PauseEnvironmentService(prisma);
    const env = await authEnv(loaded, prisma, environment.id);

    expect(await service.call(env, "paused")).toEqual({ success: true, state: "paused" });
    expect(await engine.runQueue.getEnvConcurrencyLimit(env)).toBe(0);

    // The service holds an environment read before the resume update, so its `paused` is
    // stale by the time the limit is pushed — resuming must still restore the real limit.
    expect(await service.call(env, "resumed")).toEqual({ success: true, state: "resumed" });
    expect(await engine.runQueue.getEnvConcurrencyLimit(env)).toBe(17);
  });
});

describe("PauseEnvironmentService", () => {
  containerTest(
    "resumes a manually paused env (pauseSource stays null through pause and resume)",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadService(redisOptions);
      const { environment } = await seedProductionEnv(prisma);
      const service = new loaded.PauseEnvironmentService(prisma);
      const env = await authEnv(loaded, prisma, environment.id);

      const paused = await service.call(env, "paused");
      expect(paused).toEqual({ success: true, state: "paused" });

      const afterPause = await prisma.runtimeEnvironment.findFirstOrThrow({
        where: { id: environment.id },
      });
      // Manual pause never sets pauseSource; leaving it null is what tripped the
      // pre-fix resume guard (Prisma NOT on a nullable field excludes NULL rows).
      expect(afterPause.paused).toBe(true);
      expect(afterPause.pauseSource).toBeNull();

      const resumed = await service.call(env, "resumed");
      expect(resumed).toEqual({ success: true, state: "resumed" });

      const afterResume = await prisma.runtimeEnvironment.findFirstOrThrow({
        where: { id: environment.id },
      });
      expect(afterResume.paused).toBe(false);
      expect(afterResume.pauseSource).toBeNull();
    }
  );

  containerTest(
    "rejects resume of a billing-limit paused env and leaves it paused",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadService(redisOptions);
      const { environment } = await seedProductionEnv(prisma);
      await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { paused: true, pauseSource: EnvironmentPauseSource.BILLING_LIMIT },
      });

      const service = new loaded.PauseEnvironmentService(prisma);
      const env = await authEnv(loaded, prisma, environment.id);

      const result = await service.call(env, "resumed");
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error).toContain("billing limit");

      const after = await prisma.runtimeEnvironment.findFirstOrThrow({
        where: { id: environment.id },
      });
      expect(after.paused).toBe(true);
      expect(after.pauseSource).toBe(EnvironmentPauseSource.BILLING_LIMIT);
    }
  );

  containerTest(
    "manual pause while billing-limit paused is a no-op that preserves pauseSource",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadService(redisOptions);
      const { environment } = await seedProductionEnv(prisma);
      await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { paused: true, pauseSource: EnvironmentPauseSource.BILLING_LIMIT },
      });

      const service = new loaded.PauseEnvironmentService(prisma);
      const env = await authEnv(loaded, prisma, environment.id);

      const result = await service.call(env, "paused");
      // Idempotent success without overwriting pauseSource, so billing-limit
      // converge can still find and unpause this env on resolve.
      expect(result).toEqual({ success: true, state: "paused" });

      const after = await prisma.runtimeEnvironment.findFirstOrThrow({
        where: { id: environment.id },
      });
      expect(after.paused).toBe(true);
      expect(after.pauseSource).toBe(EnvironmentPauseSource.BILLING_LIMIT);
    }
  );
});
