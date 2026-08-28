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

describe("PauseEnvironmentService", () => {
  containerTest(
    "a pause writes 0 and a resume restores the limit",
    async ({ prisma, redisOptions }) => {
      const loaded = await loadEnvConcurrencyLimitPauseServices(redisOptions);
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
