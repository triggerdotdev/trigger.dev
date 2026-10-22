import { postgresAndRedisTest } from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import { CronSchema, Worker } from "@trigger.dev/redis-worker";
import type { RedisOptions } from "ioredis";
import { vi } from "vitest";
import { z } from "zod";

function createAlertInspector(redisOptions: RedisOptions) {
  return new Worker({
    name: "alert-engine-worker",
    redisOptions: { ...redisOptions, keyPrefix: "alerts:engine:" },
    catalog: {
      "alerts.evaluate": {
        schema: z.object({ alertId: z.string() }),
        visibilityTimeoutMs: 120_000,
        retry: { maxAttempts: 2 },
      },
      "alerts.reconcile": {
        schema: CronSchema,
        visibilityTimeoutMs: 300_000,
        retry: { maxAttempts: 1 },
      },
    },
    jobs: {
      "alerts.evaluate": async () => {},
      "alerts.reconcile": async () => {},
    },
    logger: new Logger("test", "error"),
  });
}

export type AlertInspector = ReturnType<typeof createAlertInspector>;

type Singletons = { alertEngineWorker?: { stop: () => Promise<unknown> } };

function singletons() {
  return ((globalThis as any).__trigger_singletons ??= {}) as Singletons;
}

async function dropEngineSingleton() {
  await singletons().alertEngineWorker?.stop();
  delete singletons().alertEngineWorker;
}

// Points the real alert engine worker singleton at the test Redis; the inspector never starts.
export const alertEngineTest = postgresAndRedisTest.extend<{ engine: AlertInspector }>({
  engine: [
    async ({ redisOptions }, use) => {
      const overrides: Record<string, string> = {
        ALERT_ENGINE_WORKER_REDIS_HOST: redisOptions.host ?? "localhost",
        ALERT_ENGINE_WORKER_REDIS_PORT: String(redisOptions.port),
        ALERT_ENGINE_WORKER_REDIS_TLS_DISABLED: "true",
        ALERT_ENGINE_WORKER_ENABLED: "false",
      };
      const previous = Object.fromEntries(
        Object.keys(overrides).map((key) => [key, process.env[key]])
      );
      Object.assign(process.env, overrides);

      try {
        await dropEngineSingleton();
        vi.resetModules();

        const inspector = createAlertInspector(redisOptions);
        try {
          await use(inspector);
        } finally {
          await dropEngineSingleton();
          await inspector.stop();
        }
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
    { auto: true },
  ],
});
