import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { PostgresRunStore } from "@internal/run-store";
import { expect } from "vitest";
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

describe("RunEngine runStore injectability", () => {
  containerTest("defaults the store when none is injected", async ({ prisma, redisOptions }) => {
    const engine = new RunEngine(createEngineOptions(redisOptions, prisma));

    try {
      expect(engine.runStore).toBeDefined();
    } finally {
      await engine.quit();
    }
  });

  containerTest("uses an explicitly injected store as-is", async ({ prisma, redisOptions }) => {
    const injectedStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });

    const engine = new RunEngine({
      ...createEngineOptions(redisOptions, prisma),
      store: injectedStore,
    });

    try {
      expect(engine.runStore).toBe(injectedStore);
    } finally {
      await engine.quit();
    }
  });

  // The happy-path "Single run (success)" trigger slice, run once per store variant.
  // Each variant runs in its own containerTest (fresh DB) so the two RunEngines never
  // share state — proving the injected store path is behavior-identical to the default.
  async function assertTriggerLandsRun(
    prisma: any,
    redisOptions: any,
    store: PostgresRunStore | undefined,
    friendlyId: string
  ) {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const engine = new RunEngine({
      ...createEngineOptions(redisOptions, prisma),
      ...(store ? { store } : {}),
    });

    try {
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const run = await engine.trigger(
        {
          number: 1,
          friendlyId,
          environment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          workerQueue: "main",
          queue: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );

      expect(run).toBeDefined();
      expect(run.friendlyId).toBe(friendlyId);

      const runFromDb = await prisma.taskRun.findUnique({
        where: { friendlyId },
      });
      expect(runFromDb).toBeDefined();
      expect(runFromDb?.id).toBe(run.id);
    } finally {
      await engine.quit();
    }
  }

  containerTest(
    "injected store path is behavior-identical to default (default store)",
    async ({ prisma, redisOptions }) => {
      await assertTriggerLandsRun(prisma, redisOptions, undefined, "run_default1234");
    }
  );

  containerTest(
    "injected store path is behavior-identical to default (injected store)",
    async ({ prisma, redisOptions }) => {
      const injectedStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await assertTriggerLandsRun(prisma, redisOptions, injectedStore, "run_injected5678");
    }
  );
});
