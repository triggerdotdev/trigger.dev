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

describe("updateEnvConcurrencyLimits directly", () => {
  containerTest(
    "pushes the real limit for a running environment",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadEnvConcurrencyLimitPauseServices(redisOptions);
      const engine = useEngine(prisma, redisOptions);

      const { environment } = await seedProductionEnv(prisma, 17);
      const env = await authEnv(loaded, prisma, environment.id);

      await loaded.updateEnvConcurrencyLimits(env, undefined, prisma);

      expect(await engine.runQueue.getEnvConcurrencyLimit(env)).toBe(17);
    }
  );

  containerTest(
    "an explicit limit wins over the stored pause state",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadEnvConcurrencyLimitPauseServices(redisOptions);
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
});
