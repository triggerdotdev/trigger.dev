import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { containerTestWithIsolatedRedisNoClickhouse } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { expect } from "vitest";
import { RunEngine } from "../index.js";

async function connectedClientCount(redis: Redis): Promise<number> {
  const clientsInfo = await redis.info("clients");
  const match = clientsInfo.match(/^connected_clients:(\d+)$/m);

  if (!match) {
    throw new Error("Redis INFO clients response did not include connected_clients");
  }

  return Number(match[1]);
}

function engineOptions(redisOptions: RedisOptions) {
  // Keep caches and consumers lazy so every connection opened by this test belongs to a shutdown
  // resource. The run-lock client remains eager to exercise Redlock's ownership of it.
  const lazyRedisOptions = { ...redisOptions, lazyConnect: true };

  return {
    worker: {
      disabled: true,
      redis: lazyRedisOptions,
      workers: 1,
      tasksPerWorker: 1,
      pollIntervalMs: 10,
      immediatePollIntervalMs: 10,
      shutdownTimeoutMs: 30_000,
    },
    queue: {
      redis: lazyRedisOptions,
      masterQueueConsumersDisabled: true,
      ttlSystem: { disabled: true },
      logLevel: "error" as const,
    },
    runLock: { redis: redisOptions },
    cache: { redis: lazyRedisOptions },
    debounce: { redis: lazyRedisOptions },
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
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("run-engine-shutdown-test", "0.0.0"),
    logger: new Logger("run-engine-shutdown-test", "error"),
  };
}

describe("RunEngine.quit", () => {
  containerTestWithIsolatedRedisNoClickhouse(
    "is concurrency-safe, repeatable, and returns Redis connections to baseline",
    { timeout: 60_000 },
    async ({ prisma, redisOptions }) => {
      await prisma.$queryRaw`SELECT 1`;

      const observer = createRedisClient(redisOptions);
      await observer.ping();
      const baselineConnections = await connectedClientCount(observer);
      const engine = new RunEngine({ prisma, ...engineOptions(redisOptions) });

      try {
        await expect
          .poll(() => connectedClientCount(observer))
          .toBeGreaterThan(baselineConnections);

        const firstQuit = engine.quit();
        const concurrentQuit = engine.quit();
        expect(concurrentQuit).toBe(firstQuit);

        await Promise.all([firstQuit, concurrentQuit, engine.quit()]);

        const repeatedQuit = engine.quit();
        expect(repeatedQuit).toBe(firstQuit);
        await repeatedQuit;

        await expect.poll(() => connectedClientCount(observer)).toBe(baselineConnections);
      } finally {
        await engine.quit();
        await observer.quit();
      }
    }
  );
});
