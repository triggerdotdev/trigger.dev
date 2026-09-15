// The snapshot route STAMPED on the queue message at enqueue (from the run's birth residency), not the
// live per-org dial, governs residency across enqueue -> dial-change -> dequeue -> lock. Proven through
// the ACTUAL run-engine queue (real enqueueSystem + dequeueSystem) against REAL Postgres + Redis, no mocks.
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
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const ROUTE = "logical:1";

describe("RunEngine queue poll-lag snapshot route", () => {
  containerTest(
    "a redis-primary run enqueued at redis-only, dequeued at dial=undefined, honors the STAMPED route: no TRES row, MemoryDB head advances",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const orgId = authenticatedEnvironment.organizationId;

      const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      // The consumer-visible dial, flipped mid-test to simulate a poll-lagging pod.
      let dial: SnapshotStoreDial | undefined = "redis-only";
      const runStore = new TaskRunExecutionSnapshotStore(delegate, {
        store,
        mode: "redis-only",
        resolveDial: () => dial,
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
        queue: { redis: redisOptions },
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

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Born redis-primary while the org dial is redis-only. Delayed far in the future so the
        // worker never auto-enqueues it; we drive the enqueue explicitly below.
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_polllag",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-polllag",
            spanId: "s-polllag",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 60_000),
          },
          prisma
        );
        expect(await store.readBirthResidency(run.id)).toBe("redis-primary");

        // Enqueue through the REAL enqueue path (enqueueSystem.enqueueRun), which reads the run's
        // durable birth residency and STAMPS the route on the queue message. Clear the delay so the
        // run is eligible now (the delayed trigger left queueTimestamp in the future).
        await prisma.taskRun.update({
          where: { id: run.id },
          data: { delayUntil: null, queueTimestamp: new Date() },
        });
        const runRow = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        await engine.enqueueSystem.enqueueRun({
          run: runRow,
          env: authenticatedEnvironment,
          enableFastPath: true,
        });

        // The consumer's poll lags: its dial no longer sees the org's enrollment. A route read at this
        // dial returns undefined, so ONLY the already-stamped wire route can carry residency now.
        dial = undefined;
        expect(await runStore.readSnapshotRoute(run.id, orgId)).toBeUndefined();

        // Dequeue through the REAL dequeue path: it parses the stamped route and threads it into the
        // lock transition. Retry while the debounced mover promotes the message to the worker queue.
        let dequeued: Awaited<ReturnType<typeof engine.dequeueFromWorkerQueue>> = [];
        for (let i = 0; i < 20 && dequeued.length === 0; i++) {
          await setTimeout(500);
          dequeued = await engine.dequeueFromWorkerQueue({
            consumerId: "poll_lag_consumer",
            workerQueue: "main",
          });
        }
        expect(dequeued.length).toBe(1);
        const locked = dequeued[0];
        expect(locked.run.id).toBe(run.id);

        // The lock transition honored the run's TRUE residency (redis-primary from the stamped route),
        // not the undefined dial: no Postgres TRES row, and the MemoryDB head advanced to it.
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
});
