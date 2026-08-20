import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "ioredis";
import { describe, expect, onTestFinished, vi } from "vitest";
import {
  authEnv,
  createEnvConcurrencyLimitPauseTestEngine,
  type EnvConcurrencyLimitPauseTestEngine,
  loadEnvConcurrencyLimitPauseServices,
  seedProductionEnv,
} from "./helpers/envConcurrencyLimitPauseTestHelpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// test/setup.ts replaces the app's engine singleton with a no-op for every webapp suite, which
// would make any assertion about the RunQueue limits vacuous. Every test in this file asserts on
// real RunQueue state, so put a real RunEngine - built on the test's own Redis container - back
// behind the singleton. No test here uses the no-op default.
const { engineHolder } = vi.hoisted(() => ({
  engineHolder: { current: undefined as EnvConcurrencyLimitPauseTestEngine | undefined },
}));

vi.mock("~/v3/runEngine.server", () => ({
  engine: new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) =>
      engineHolder.current ? Reflect.get(engineHolder.current, prop) : undefined,
  }),
}));

function useEngine(prisma: PrismaClient, redisOptions: RedisOptions) {
  const engine = createEnvConcurrencyLimitPauseTestEngine(prisma, redisOptions);
  engineHolder.current = engine;
  onTestFinished(async () => {
    engineHolder.current = undefined;
    await engine.quit();
  });
  return engine;
}

// An unset RunQueue limit reads back as the engine default (10), so neither the 0 nor the 17
// assertions below can pass just because a push never happened.
describe("updateEnvConcurrencyLimits with stale environments", () => {
  containerTest(
    "clamps to 0 when the environment is paused, even though the caller's copy says otherwise",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadEnvConcurrencyLimitPauseServices(redisOptions);
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
    "restores the real limit when the environment was resumed while the request was in flight",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadEnvConcurrencyLimitPauseServices(redisOptions);
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
});
