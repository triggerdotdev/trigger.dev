// Durable server-side evidence, not worker protocol fields or a pod's current dial, preserves birth
// residency through start, checkpoint, waitpoint resume, retry and completion. Two real engines share
// Postgres and Redis while the consumer's dial lags the producer's. No mocks.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import {
  WorkerApiRunAttemptCompleteRequestBody,
  WorkerApiRunAttemptStartRequestBody,
  WorkerApiSuspendRunRequestBody,
} from "@trigger.dev/core/v3/runEngineWorker";
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

// Exercise the unchanged worker request schemas without any storage-routing fields.
function overTheWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("RunEngine execution-lifecycle snapshot route", () => {
  containerTest(
    "a redis-primary run completes the route-free worker lifecycle on a dial=undefined consumer: head advances at every transition, no TRES rows",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // One shared MemoryDB snapshot store: both "pods" (and the assertions) read the same head.
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      function makeRunStore(dial: () => SnapshotStoreDial | undefined) {
        const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
        return new TaskRunExecutionSnapshotStore(delegate, {
          store: snapshotStore,
          mode: "redis-only",
          resolveDial: dial,
          residencyResolver: new SnapshotResidencyResolver({
            store: snapshotStore,
          }),
          resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
          logicalRunStoreRoute: ROUTE,
        });
      }

      // Producer = control plane, dial live. Consumer = worker-facing pod, dial poll-lagging (undefined).
      const producer = new RunEngine({
        prisma,
        store: makeRunStore(() => "redis-only"),
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

      const consumer = new RunEngine({
        prisma,
        store: makeRunStore(() => undefined),
        worker: { redis: redisOptions, disabled: true },
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

      // Assert a transition landed in MemoryDB and NOT in Postgres — i.e. residency was honored.
      async function expectResidentHead(snapshotId: string) {
        expect(
          await prisma.taskRunExecutionSnapshot.count({ where: { id: snapshotId } }),
          `snapshot ${snapshotId} must NOT be a Postgres TRES row`
        ).toBe(0);
        const head = await snapshotStore.getLatest(runId);
        assertNonNullable(head);
        expect(head.id, "MemoryDB head must have advanced to the transition").toBe(snapshotId);
      }

      // Drain the producer's master queue and dequeue on the consumer; retry while the debounced mover
      // and background jobs settle.
      async function dequeueOnConsumer() {
        for (let i = 0; i < 25; i++) {
          await producer.runQueue.processMasterQueueForEnvironment(env.id, 5);
          const dequeued = await consumer.dequeueFromWorkerQueue({
            consumerId: "polllag_consumer",
            workerQueue: "main",
          });
          if (dequeued.length > 0) return dequeued[0];
          await setTimeout(300);
        }
        throw new Error("run never reached the worker queue");
      }

      let runId = "";
      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(producer, env, taskIdentifier);

        // Birth: producer dial is redis-only -> the run is born redis-primary. Delayed so nothing
        // auto-enqueues it; we drive the enqueue explicitly.
        const run = await producer.trigger(
          {
            number: 1,
            friendlyId: "run_lifecycle",
            environment: env,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-lifecycle",
            spanId: "s-lifecycle",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 60_000),
          },
          prisma
        );
        runId = run.id;
        expect(await snapshotStore.readBirthResidency(runId)).toBe("redis-primary");

        // Enqueue through the real enqueue path (stamps the route on the message from birth residency).
        await prisma.taskRun.update({
          where: { id: runId },
          data: { delayUntil: null, queueTimestamp: new Date() },
        });
        const runRow = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
        await producer.enqueueSystem.enqueueRun({ run: runRow, env, enableFastPath: true });

        // ---- DEQUEUE (consumer, dial=undefined) ----
        const dequeued = await dequeueOnConsumer();
        expect(dequeued.run.id).toBe(runId);
        expect(await consumer.runStore.readSnapshotRoute(runId, env.organizationId)).toMatchObject({
          runId,
          residency: "redis-primary",
        });
        expect(dequeued).not.toHaveProperty("snapshotRoute");
        await expectResidentHead(dequeued.snapshot.id);

        // ---- START (crosses WorkerApiRunAttemptStartRequestBody) ----
        const startBody = WorkerApiRunAttemptStartRequestBody.parse(
          overTheWire({ isWarmStart: false })
        );
        expect(startBody).not.toHaveProperty("snapshotRoute");
        const attempt = await consumer.startRunAttempt({
          runId,
          snapshotId: dequeued.snapshot.id,
        });
        await expectResidentHead(attempt.snapshot.id);

        // ---- SUSPEND via checkpoint (crosses WorkerApiSuspendRunRequestBody) ----
        const waitpoint = await producer.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });
        const blocked = await consumer.blockRunWithWaitpoint({
          runId,
          waitpoints: waitpoint.waitpoint.id,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });
        await expectResidentHead(blocked.id);

        const suspendBody = WorkerApiSuspendRunRequestBody.parse(
          overTheWire({
            success: true,
            checkpoint: {
              type: "DOCKER",
              reason: "TEST",
              location: "test-location",
              imageRef: "test-image-ref",
            },
          })
        );
        const checkpointResult = await consumer.createCheckpoint({
          runId,
          snapshotId: blocked.id,
          checkpoint: suspendBody.success ? suspendBody.checkpoint : (undefined as never),
        });
        expect(checkpointResult.ok).toBe(true);
        const suspendedSnapshot = checkpointResult.ok ? checkpointResult.snapshot : null;
        assertNonNullable(suspendedSnapshot);
        expect(suspendedSnapshot.executionStatus).toBe("SUSPENDED");
        await expectResidentHead(suspendedSnapshot.id);

        // ---- RESUME: the background worker preserves birth residency on re-enqueue. ----
        await producer.completeWaitpoint({ id: waitpoint.waitpoint.id });
        const restored = await dequeueOnConsumer();
        expect(restored.run.id).toBe(runId);
        expect(restored).not.toHaveProperty("snapshotRoute");
        await expectResidentHead(restored.snapshot.id);

        const continued = await consumer.continueRunExecution({
          runId,
          snapshotId: restored.snapshot.id,
        });
        expect(continued.snapshot.executionStatus).toBe("EXECUTING");
        await expectResidentHead(continued.snapshot.id);

        // ---- COMPLETE (crosses WorkerApiRunAttemptCompleteRequestBody) ----
        const completeBody = WorkerApiRunAttemptCompleteRequestBody.parse(
          overTheWire({
            completion: {
              ok: true,
              id: runId,
              output: `{"ok":true}`,
              outputType: "application/json",
            },
          })
        );
        const completed = await consumer.completeRunAttempt({
          runId,
          snapshotId: continued.snapshot.id,
          completion: completeBody.completion,
        });
        expect(completed.attemptStatus).toBe("RUN_FINISHED");
        await expectResidentHead(completed.snapshot.id);

        // Nothing about this redis-primary run ever touched Postgres snapshots.
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "retry through the real nack/requeue queued boundary carries the route: QUEUED snapshot stays resident on a dial=undefined consumer",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      function makeRunStore(dial: () => SnapshotStoreDial | undefined) {
        const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
        return new TaskRunExecutionSnapshotStore(delegate, {
          store: snapshotStore,
          mode: "redis-only",
          resolveDial: dial,
          residencyResolver: new SnapshotResidencyResolver({
            store: snapshotStore,
          }),
          resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
          logicalRunStoreRoute: ROUTE,
        });
      }

      const producer = new RunEngine({
        prisma,
        store: makeRunStore(() => "redis-only"),
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

      // retryWarmStartThresholdMs: 0 forces the retry down the nack/requeue (QUEUED) path.
      const consumer = new RunEngine({
        prisma,
        store: makeRunStore(() => undefined),
        worker: { redis: redisOptions, disabled: true },
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
        retryWarmStartThresholdMs: 0,
        tracer: trace.getTracer("test", "0.0.0"),
      });

      let runId = "";
      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(producer, env, taskIdentifier);

        const run = await producer.trigger(
          {
            number: 1,
            friendlyId: "run_retry",
            environment: env,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-retry",
            spanId: "s-retry",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 60_000),
          },
          prisma
        );
        runId = run.id;

        await prisma.taskRun.update({
          where: { id: runId },
          data: { delayUntil: null, queueTimestamp: new Date() },
        });
        const runRow = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
        await producer.enqueueSystem.enqueueRun({ run: runRow, env, enableFastPath: true });

        async function dequeueOnConsumer() {
          for (let i = 0; i < 25; i++) {
            await producer.runQueue.processMasterQueueForEnvironment(env.id, 5);
            const dequeued = await consumer.dequeueFromWorkerQueue({
              consumerId: "retry_consumer",
              workerQueue: "main",
            });
            if (dequeued.length > 0) return dequeued[0];
            await setTimeout(300);
          }
          throw new Error("run never reached the worker queue");
        }

        const dequeued = await dequeueOnConsumer();
        expect(dequeued).not.toHaveProperty("snapshotRoute");
        const attempt = await consumer.startRunAttempt({
          runId,
          snapshotId: dequeued.snapshot.id,
        });

        // Fail with a retry -> real tryNackAndRequeue path: the message is nacked back onto the queue and
        // a QUEUED snapshot is written on the CONSUMER whose dial is undefined, without a client route.
        const completeBody = WorkerApiRunAttemptCompleteRequestBody.parse(
          overTheWire({
            completion: {
              ok: false,
              id: runId,
              error: { type: "BUILT_IN_ERROR", name: "Error", message: "boom", stackTrace: "" },
              retry: { timestamp: Date.now() + 50, delay: 50 },
            },
          })
        );
        const failed = await consumer.completeRunAttempt({
          runId,
          snapshotId: attempt.snapshot.id,
          completion: completeBody.completion,
        });
        expect(failed.attemptStatus).toBe("RETRY_QUEUED");

        // The requeue's QUEUED snapshot is resident (MemoryDB head, no TRES) and the run re-dequeues with
        // the route still on the message.
        expect(
          await prisma.taskRunExecutionSnapshot.count({ where: { id: failed.snapshot.id } })
        ).toBe(0);
        const head = await snapshotStore.getLatest(runId);
        assertNonNullable(head);
        expect(head.id).toBe(failed.snapshot.id);

        const redequeued = await dequeueOnConsumer();
        expect(redequeued.run.id).toBe(runId);
        expect(redequeued).not.toHaveProperty("snapshotRoute");
        expect(
          await prisma.taskRunExecutionSnapshot.count({ where: { id: redequeued.snapshot.id } })
        ).toBe(0);

        // Route-free terminal cancellation preserves the same residency.
        const canceled = await consumer.cancelRun({
          runId,
          finalizeRun: true,
        });
        expect(
          await prisma.taskRunExecutionSnapshot.count({ where: { id: canceled.snapshot.id } })
        ).toBe(0);

        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "a scheduled transition (delayed-run promotion) carries the durable route on a dial=undefined consumer: promoted to QUEUED in MemoryDB, no TRES rows",
    async ({ prisma, redisOptions }) => {
      // A run-ID-only scheduled job resolves durable birth evidence even when its pod's dial lags.
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });

      function makeRunStore(dial: () => SnapshotStoreDial | undefined) {
        const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
        return new TaskRunExecutionSnapshotStore(delegate, {
          store: snapshotStore,
          mode: "redis-only",
          resolveDial: dial,
          residencyResolver: new SnapshotResidencyResolver({
            store: snapshotStore,
          }),
          resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
          logicalRunStoreRoute: ROUTE,
        });
      }
      const machines = {
        defaultMachine: "small-1x",
        machines: {
          "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
        },
        baseCostInCents: 0.0001,
      };

      // Producer births the delayed run redis-primary (dial=redis-only). It does not promote (no worker).
      const producer = new RunEngine({
        prisma,
        store: makeRunStore(() => "redis-only"),
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
      // The consumer is a poll-lagging pod (dial=undefined). It drives the scheduled delayed-run
      // promotion directly, deterministically, exactly as delayedRunSystem.test.ts does.
      const consumer = new RunEngine({
        prisma,
        store: makeRunStore(() => undefined),
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

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(producer, env, taskIdentifier);

        const run = await producer.trigger(
          {
            number: 1,
            friendlyId: "run_delayed",
            environment: env,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t-delayed",
            spanId: "s-delayed",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 60_000),
          },
          prisma
        );
        const runId = run.id;

        // Born delayed and redis-primary: head in MemoryDB, no TRES row for the birth.
        const delayed = await producer.getRunExecutionData({ runId });
        assertNonNullable(delayed);
        expect(delayed.snapshot.executionStatus).toBe("DELAYED");
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);

        // Move the delay into the past, then drive the promotion on the dial=undefined consumer. This is
        // the scheduled transition must stay redis-primary rather than following the consumer's dial.
        await prisma.taskRun.update({
          where: { id: runId },
          data: { delayUntil: new Date(Date.now() - 1_000) },
        });
        await consumer.delayedRunSystem.enqueueDelayedRun({ runId });

        const promoted = await consumer.getRunExecutionData({ runId });
        assertNonNullable(promoted);
        expect(promoted.snapshot.executionStatus).toBe("QUEUED");

        // The promotion kept the run redis-primary: the head is in MemoryDB and NO TRES row was written
        // for the run (birth or promotion), despite the promoting pod's dial reading undefined.
        const head = await snapshotStore.getLatest(runId);
        assertNonNullable(head);
        expect(head.id).toBe(promoted.snapshot.id);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
      } finally {
        await producer.quit();
        await consumer.quit();
        await snapshotStore.quit();
      }
    }
  );
});
