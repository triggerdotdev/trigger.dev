import { createServer } from "node:net";
import {
  RunEngine,
  StoreWaitpointCoordinator,
  WaitpointStoreCoordinator,
} from "@internal/run-engine";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "ioredis";
import { describe, expect, vi } from "vitest";
import { createWaitpointStoreEnabledResolver } from "~/v3/utils/waitpointStoreEnabled.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// The waitpoint cache builds its Redis client at import, so point it at the container first.
async function load(redisOptions: RedisOptions) {
  process.env.CACHE_REDIS_HOST = redisOptions.host;
  process.env.CACHE_REDIS_PORT = String(redisOptions.port);
  process.env.CACHE_REDIS_TLS_DISABLED = "true";
  const [append, cache] = await Promise.all([
    import("~/services/realtime/sessionChannelAppend.server"),
    import("~/services/sessionStreamWaitpointCache.server"),
  ]);
  return { ...append, ...cache };
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("completeSessionStreamWaitpoints", () => {
  // Catches: a failed waitpoint-store flag lookup failing an already-durable append, or dropping the drained waiters instead of completing them.
  containerTestWithIsolatedRedis(
    "a failed flag lookup does not fail the append and still completes drained waiters",
    async ({ prisma, redisOptions }) => {
      const loaded = await load(redisOptions);
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const unreachable = new PrismaClient({
        datasources: { db: { url: `postgresql://u:p@127.0.0.1:${await closedPort()}/db` } },
      });
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions, masterQueueConsumersDisabled: true },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: { "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("session-stream-waitpoints-flag-lookup-test"),
        waitpointStore: store,
        waitpointRouting: { store: new StoreWaitpointCoordinator({ store }) },
        // The production resolver, reading org flags through a real client whose database is down.
        waitpointStoreEnabled: createWaitpointStoreEnabledResolver(() => undefined, unreachable),
      });
      try {
        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: environment.id,
          projectId: environment.project.id,
        });
        await loaded.addSessionStreamWaitpoint(environment.id, "chat-1", "in", waitpoint.id);
        const part = JSON.stringify({ text: "hi" });

        await expect(
          loaded.completeSessionStreamWaitpoints(
            environment,
            "chat-1",
            "in",
            part,
            undefined,
            engine
          )
        ).resolves.toBeUndefined();

        expect(
          await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } })
        ).toMatchObject({ status: "COMPLETED", output: part });
      } finally {
        await engine.quit();
        await store.quit();
        await unreachable.$disconnect();
      }
    }
  );
});
