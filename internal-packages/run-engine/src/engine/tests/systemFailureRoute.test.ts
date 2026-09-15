// ADDENDUM #3: the exceptional-failure entry systemFailure mints a transition on whatever pod calls
// it (e.g. the tryNackAndRequeue dead-letter fallback, or an engine-detected crash). It must carry the
// run's route so the transition honors durable residency on a poll-lagging pod. Here a PRODUCER
// (dial=redis-only) births a redis-primary run; the CONSUMER (dial=undefined) drives it to EXECUTING
// and then systemFailure with the carried route. The resulting transition must stay in MemoryDB with
// no TRES row. No mocks.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
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

function makeStore(
  prisma: any,
  snapshotStore: RedisSnapshotStore,
  dial: () => SnapshotStoreDial | undefined
) {
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  return new TaskRunExecutionSnapshotStore(delegate, {
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
}

describe("RunEngine systemFailure route (ADDENDUM #3)", () => {
  containerTest(
    "systemFailure with a carried route stays resident on a dial=undefined consumer (no TRES)",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      const producer = new RunEngine({
        prisma,
        store: makeStore(prisma, snapshotStore, () => "redis-only"),
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
      const consumer = new RunEngine({
        prisma,
        store: makeStore(prisma, snapshotStore, () => undefined),
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

      let runId = "";
      try {
        await setupBackgroundWorker(producer, env, "test-task");

        const run = await producer.trigger(
          {
            number: 1,
            friendlyId: "run_sf",
            environment: env,
            taskIdentifier: "test-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-sf",
            spanId: "s-sf",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );
        runId = run.id;

        let dq;
        for (let i = 0; i < 25; i++) {
          await producer.runQueue.processMasterQueueForEnvironment(env.id, 5);
          const d = await consumer.dequeueFromWorkerQueue({
            consumerId: "sf_consumer",
            workerQueue: "main",
          });
          if (d.length > 0) {
            dq = d[0];
            break;
          }
          await setTimeout(200);
        }
        assertNonNullable(dq);
        const controllerRoute = dq.snapshotRoute;
        const attempt = await consumer.startRunAttempt({
          runId,
          snapshotId: dq.snapshot.id,
          snapshotRoute: controllerRoute,
        });
        expect(attempt.snapshot.executionStatus).toBe("EXECUTING");

        const result = await consumer.runAttemptSystem.systemFailure({
          runId,
          error: { type: "INTERNAL_ERROR", code: "TASK_RUN_CRASHED", message: "boom" },
          snapshotRoute: controllerRoute,
        });

        // Whatever the outcome (retry or terminal), the transition it wrote must be resident.
        expect(
          await prisma.taskRunExecutionSnapshot.count({ where: { id: result.snapshot.id } }),
          `systemFailure snapshot ${result.snapshot.id} must NOT be a Postgres TRES row`
        ).toBe(0);
        const head = await snapshotStore.getLatest(runId);
        assertNonNullable(head);
        expect(head.id).toBe(result.snapshot.id);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );
});
