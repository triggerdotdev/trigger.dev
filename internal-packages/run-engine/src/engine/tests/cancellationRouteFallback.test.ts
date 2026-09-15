// ADDENDUM #3 / CANCELLATION: cancelRun must honor a run's durable residency even when the caller
// carries NO route. CancelTaskRunService and the finalization mollifier both call engine.cancelRun
// with no snapshotRoute; on a poll-lagging / undefined-dial pod the terminal transition would take the
// never-enrolled Postgres shortcut and leave a redis-primary run's MemoryDB head un-advanced. cancelRun
// now resolves the residency ONCE (forceDurable) as a central fallback, so every caller is covered with
// no per-caller duplication. A PRODUCER births the run redis-primary; an undefined-dial CONSUMER cancels
// it route-less. Real infra, no mocks.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  SnapshotResidencyResolver,
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreDial,
} from "@internal/run-store";
import { RunEngine } from "../index.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const ROUTE = "logical:1";
const machines = {
  defaultMachine: "small-1x",
  machines: {
    "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
  },
  baseCostInCents: 0.0001,
};

function makeEngine(
  prisma: any,
  redisOptions: any,
  snapshotStore: RedisSnapshotStore,
  dial: () => SnapshotStoreDial | undefined
) {
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const store = new TaskRunExecutionSnapshotStore(delegate, {
    store: snapshotStore,
    mode: "redis-only",
    resolveDial: dial,
    residencyResolver: new SnapshotResidencyResolver({
      store: snapshotStore,
      taskRunExists: async (id: string) => (await prisma.taskRun.count({ where: { id } })) > 0,
    }),
    resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
    logicalRunStoreRoute: ROUTE,
  });
  return new RunEngine({
    prisma,
    store,
    worker: { redis: redisOptions, disabled: true },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines,
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

function triggerInput(env: any, friendlyId: string, tag: string) {
  return {
    number: 1,
    friendlyId,
    environment: env,
    taskIdentifier: "test-task",
    payload: "{}",
    payloadType: "application/json",
    context: {},
    traceContext: {},
    traceId: `t-${tag}`,
    spanId: `s-${tag}`,
    workerQueue: "main",
    queue: "task/test-task",
    isTest: false,
    tags: [],
  };
}

describe("RunEngine cancellation route fallback (ADDENDUM #3)", () => {
  containerTest(
    "a route-less cancel on a dial=undefined consumer advances a redis-primary run's MemoryDB head to FINISHED (no TRES)",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const producer = makeEngine(prisma, redisOptions, snapshotStore, () => "redis-only");
      const consumer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined);

      try {
        await setupBackgroundWorker(producer, env, "test-task");

        // Redis-primary birth: no TRES row.
        const rp = await producer.trigger(triggerInput(env, "run_cancel", "cx"), prisma);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: rp.id } })).toBe(0);

        // The undefined-dial consumer cancels it WITHOUT a carried route (as CancelTaskRunService and
        // the mollifier do). The central fallback resolves the run's residency, so the terminal snapshot
        // lands in MemoryDB rather than being flipped only in Postgres.
        const result = await consumer.cancelRun({ runId: rp.id, reason: "Canceled by user" });
        expect(result.snapshot.executionStatus).toBe("FINISHED");

        const data = await consumer.getRunExecutionData({ runId: rp.id });
        assertNonNullable(data);
        expect(data.snapshot.executionStatus).toBe("FINISHED");
        expect(data.run.status).toBe("CANCELED");
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: rp.id } })).toBe(0);
        const head = await snapshotStore.getLatest(rp.id);
        assertNonNullable(head);
        expect(head.id).toBe(data.snapshot.id);
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );
});
