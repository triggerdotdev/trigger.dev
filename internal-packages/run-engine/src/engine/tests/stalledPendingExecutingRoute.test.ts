// A stalled PENDING_EXECUTING snapshot must be requeued into a redis-primary run's durable residency. The
// heartbeat payload carries no route, so on an undefined-dial engine the requeue's QUEUED snapshot would
// otherwise take the Postgres shortcut and leave the MemoryDB head at PENDING_EXECUTING. Real infra.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  SnapshotResidencyResolver,
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreDial,
} from "@internal/run-store";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 90_000 });

const ROUTE = "logical:1";
const PENDING_EXECUTING_TIMEOUT_MS = 500;
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
  dial: () => SnapshotStoreDial | undefined,
  workerEnabled: boolean
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
    worker: workerEnabled
      ? { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 }
      : { redis: redisOptions, disabled: true },
    queue: {
      redis: redisOptions,
      retryOptions: { maxTimeoutInMs: 50 },
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines,
    heartbeatTimeoutsMs: { PENDING_EXECUTING: PENDING_EXECUTING_TIMEOUT_MS },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

describe("handleStalledSnapshot honors durable residency for a stalled PENDING_EXECUTING run", () => {
  containerTest(
    "a dial=undefined engine requeues a redis-primary run into its MemoryDB head",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const producer = makeEngine(prisma, redisOptions, snapshotStore, () => "redis-only", false);
      const consumer = makeEngine(prisma, redisOptions, snapshotStore, () => undefined, true);

      try {
        await setupBackgroundWorker(producer, env, "test-task");

        async function dequeueOnConsumer() {
          for (let i = 0; i < 25; i++) {
            await producer.runQueue.processMasterQueueForEnvironment(env.id, 5);
            const dequeued = await consumer.dequeueFromWorkerQueue({
              consumerId: "stall_consumer",
              workerQueue: "main",
            });
            if (dequeued.length > 0) return dequeued[0];
            await setTimeout(300);
          }
          throw new Error("run never reached the worker queue");
        }

        const run = await producer.trigger(
          {
            number: 1,
            friendlyId: "run_stallroute",
            environment: env,
            taskIdentifier: "test-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-stall",
            spanId: "s-stall",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 60_000),
          },
          prisma
        );
        const runId = run.id;

        await prisma.taskRun.update({
          where: { id: runId },
          data: { delayUntil: null, queueTimestamp: new Date() },
        });
        const runRow = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
        await producer.enqueueSystem.enqueueRun({ run: runRow, env, enableFastPath: true });

        const first = await dequeueOnConsumer();
        assertNonNullable(first);
        expect(first.snapshotRoute?.residency).toBe("redis-primary");
        expect(first.snapshot.executionStatus).toBe("PENDING_EXECUTING");

        let latest = await consumer.getRunExecutionData({ runId });
        for (let i = 0; i < 40 && latest?.snapshot.executionStatus !== "QUEUED"; i++) {
          await setTimeout(250);
          latest = await consumer.getRunExecutionData({ runId });
        }
        assertNonNullable(latest);
        expect(latest.snapshot.executionStatus).toBe("QUEUED");
        const head = await snapshotStore.getLatest(runId);
        assertNonNullable(head);
        expect(head.id).toBe(latest.snapshot.id);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        const redelivered = await dequeueOnConsumer();
        assertNonNullable(redelivered);
        expect(redelivered.run.id).toBe(runId);
        expect(redelivered.snapshot.executionStatus).toBe("PENDING_EXECUTING");
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );
});
