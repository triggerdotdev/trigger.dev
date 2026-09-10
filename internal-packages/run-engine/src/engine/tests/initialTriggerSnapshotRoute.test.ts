// The INITIAL trigger enqueue must stamp the run's birth snapshot route (decided once inside createRun),
// so a poll-lagging dequeue honors the run's true residency. Unlike the poll-lag test, this drives a
// NORMAL IMMEDIATE engine.trigger() (no delay, no manual re-enqueue): the route can only reach the dequeue
// via the initial publishRun payload. Real Postgres + Redis, no mocks.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout as sleep } from "node:timers/promises";
import { expect } from "vitest";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  SnapshotResidencyResolver,
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreDial,
} from "@internal/run-store";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const ROUTE = "logical:1";

function buildEngine(
  prisma: any,
  redisOptions: any,
  dialRef: { dial: SnapshotStoreDial | undefined }
) {
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
  const runStore = new TaskRunExecutionSnapshotStore(delegate, {
    store,
    mode: "redis-only",
    resolveDial: () => dialRef.dial,
    residencyResolver: new SnapshotResidencyResolver({
      store,
      taskRunExists: async (id) => (await prisma.taskRun.count({ where: { id } })) > 0,
    }),
    logicalRunStoreRoute: ROUTE,
  });
  const engine = new RunEngine({
    prisma,
    store: runStore,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
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
  return { engine, store };
}

async function triggerImmediate(engine: RunEngine, env: any, prisma: any) {
  return engine.trigger(
    {
      number: 1,
      friendlyId: generateFriendlyId("run"),
      environment: env,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t-initial",
      spanId: "s-initial",
      workerQueue: "main",
      queue: "task/test-task",
      isTest: false,
      tags: [],
    },
    prisma
  );
}

async function dequeueWithRetry(engine: RunEngine) {
  let dequeued: Awaited<ReturnType<typeof engine.dequeueFromWorkerQueue>> = [];
  for (let i = 0; i < 20 && dequeued.length === 0; i++) {
    await sleep(500);
    dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "initial_trigger_consumer",
      workerQueue: "main",
    });
  }
  return dequeued;
}

describe("RunEngine initial trigger snapshot route", () => {
  containerTest(
    "a redis-primary run triggered immediately, dequeued at dial=undefined, honors the stamped route: no TRES row, MemoryDB head advances",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const dialRef: { dial: SnapshotStoreDial | undefined } = { dial: "redis-only" };
      const { engine, store } = buildEngine(prisma, redisOptions, dialRef);
      try {
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await triggerImmediate(engine, env, prisma);
        expect(await store.readBirthResidency(run.id)).toBe("redis-primary");

        // Poll lag: the consumer's dial no longer sees the enrollment. Only the STAMPED route can carry it.
        dialRef.dial = undefined;

        const dequeued = await dequeueWithRetry(engine);
        expect(dequeued.length).toBe(1);
        const locked = dequeued[0];
        expect(locked.run.id).toBe(run.id);

        // redis-primary honored from the stamped route, not the undefined dial: no Postgres TRES row.
        expect(
          await prisma.taskRunExecutionSnapshot.count({ where: { id: locked.snapshot.id } })
        ).toBe(0);
        const head = await store.getLatest(run.id);
        assertNonNullable(head);
        expect(head.id).toBe(locked.snapshot.id);
      } finally {
        await engine.quit();
        await store.quit();
      }
    }
  );

  containerTest(
    "a mirrored run triggered immediately, dequeued at dial=undefined, still advances the MemoryDB head",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const dialRef: { dial: SnapshotStoreDial | undefined } = { dial: "redis-read" };
      const { engine, store } = buildEngine(prisma, redisOptions, dialRef);
      try {
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await triggerImmediate(engine, env, prisma);
        expect(await store.readBirthResidency(run.id)).toBe("mirrored");

        dialRef.dial = undefined;

        const dequeued = await dequeueWithRetry(engine);
        expect(dequeued.length).toBe(1);
        const locked = dequeued[0];
        expect(locked.run.id).toBe(run.id);

        // Mirrored: the transition writes Postgres AND advances the MemoryDB head (stamped route honored).
        const head = await store.getLatest(run.id);
        assertNonNullable(head);
        expect(head.id).toBe(locked.snapshot.id);
      } finally {
        await engine.quit();
        await store.quit();
      }
    }
  );
});
