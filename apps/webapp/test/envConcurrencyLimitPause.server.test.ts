import { RunEngine } from "@internal/run-engine";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import type { PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "ioredis";
import { describe, expect, onTestFinished, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// test/setup.ts replaces the app's engine singleton with a no-op for every webapp suite, which
// would make any assertion about the RunQueue limits vacuous. Every test in this file asserts on
// real RunQueue state, so put a real RunEngine - built on the test's own Redis container - back
// behind the singleton. No test here uses the no-op default.
const { engineHolder } = vi.hoisted(() => ({
  engineHolder: { current: undefined as any },
}));

vi.mock("~/v3/runEngine.server", () => ({
  engine: new Proxy({} as Record<string, any>, {
    get: (_target, prop) => engineHolder.current?.[prop as string],
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

  engineHolder.current = engine;
  onTestFinished(async () => {
    engineHolder.current = undefined;
    await engine.quit();
  });

  return engine;
}

// The import chain reaches module-level singletons that throw at load time when
// REDIS_HOST/REDIS_PORT are unset (autoIncrementCounter via triggerTaskV1), so the env must point
// at the redis container BEFORE the modules are imported. Hence dynamic imports; vitest runs each
// file in its own fork, so the env mutation cannot leak into other suites.
async function loadServices(redisOptions: RedisOptions) {
  process.env.REDIS_HOST = redisOptions.host;
  process.env.REDIS_PORT = String(redisOptions.port);
  process.env.REDIS_TLS_DISABLED = "true";
  const [{ updateEnvConcurrencyLimits }, { PauseEnvironmentService }, runtimeEnvironment] =
    await Promise.all([
      import("~/v3/runQueue.server"),
      import("~/v3/services/pauseEnvironment.server"),
      import("~/models/runtimeEnvironment.server"),
    ]);
  return {
    updateEnvConcurrencyLimits,
    PauseEnvironmentService,
    authIncludeBase: runtimeEnvironment.authIncludeBase,
    toAuthenticated: runtimeEnvironment.toAuthenticated,
  };
}

type Loaded = Awaited<ReturnType<typeof loadServices>>;

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

async function seedProductionEnv(prisma: PrismaClient, maximumConcurrencyLimit: number) {
  const { organization, project } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });

  await prisma.runtimeEnvironment.update({
    where: { id: environment.id },
    data: { maximumConcurrencyLimit },
  });

  return { organization, project, environment };
}

// An unset RunQueue limit reads back as the engine default (10), so neither the 0 nor the 17
// assertions below can pass just because a push never happened.
describe("updateEnvConcurrencyLimits", () => {
  containerTest(
    "clamps to 0 when the environment is paused, even though the caller's copy says otherwise",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadServices(redisOptions);
      const engine = useEngine(prisma, redisOptions);

      const { environment } = await seedProductionEnv(prisma, 17);
      // What an argument-less caller holds: an environment read when the request authenticated,
      // before the pause landed (finalizing a deployment, registering a background worker).
      const atAuthTime = await authEnv(loaded, prisma, environment.id);
      expect(atAuthTime.paused).toBe(false);

      await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { paused: true },
      });

      await loaded.updateEnvConcurrencyLimits(atAuthTime, undefined, prisma);

      // The 0 limit is the only thing stopping dequeues, so the real limit must not go back in.
      expect(await engine.runQueue.getEnvConcurrencyLimit(atAuthTime)).toBe(0);
    }
  );

  containerTest(
    "pushes the real limit for a running environment",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadServices(redisOptions);
      const engine = useEngine(prisma, redisOptions);

      const { environment } = await seedProductionEnv(prisma, 17);
      const env = await authEnv(loaded, prisma, environment.id);

      await loaded.updateEnvConcurrencyLimits(env, undefined, prisma);

      expect(await engine.runQueue.getEnvConcurrencyLimit(env)).toBe(17);
    }
  );

  containerTest(
    "restores the real limit when the environment was resumed while the request was in flight",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadServices(redisOptions);
      const engine = useEngine(prisma, redisOptions);

      const { environment } = await seedProductionEnv(prisma, 17);
      await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { paused: true },
      });

      // Captured while paused, then resumed before the push. Trusting this copy would write 0 over
      // the restored limit and leave the env stalled with `paused: false` and nothing to fix it.
      const whilePaused = await authEnv(loaded, prisma, environment.id);
      expect(whilePaused.paused).toBe(true);

      await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { paused: false },
      });

      await loaded.updateEnvConcurrencyLimits(whilePaused, undefined, prisma);

      expect(await engine.runQueue.getEnvConcurrencyLimit(whilePaused)).toBe(17);
    }
  );

  containerTest(
    "an explicit limit wins over the stored pause state",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadServices(redisOptions);
      const engine = useEngine(prisma, redisOptions);

      const { environment } = await seedProductionEnv(prisma, 17);
      await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { paused: true },
      });
      const env = await authEnv(loaded, prisma, environment.id);

      // How billing-limit converge restores a limit as it unpauses: the caller decides, no read.
      await loaded.updateEnvConcurrencyLimits(env, 9, prisma);

      expect(await engine.runQueue.getEnvConcurrencyLimit(env)).toBe(9);
    }
  );

  containerTest(
    "a pause writes 0 and a resume restores the limit",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadServices(redisOptions);
      const engine = useEngine(prisma, redisOptions);

      const { environment } = await seedProductionEnv(prisma, 17);
      const service = new loaded.PauseEnvironmentService(prisma);
      const env = await authEnv(loaded, prisma, environment.id);

      expect(await service.call(env, "paused")).toEqual({ success: true, state: "paused" });
      expect(await engine.runQueue.getEnvConcurrencyLimit(env)).toBe(0);

      // The service holds an environment read before its own resume update, so `env.paused` is
      // stale here too.
      expect(await service.call(env, "resumed")).toEqual({ success: true, state: "resumed" });
      expect(await engine.runQueue.getEnvConcurrencyLimit(env)).toBe(17);
    }
  );
});
