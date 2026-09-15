import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";
import type { EventBusEventArgs } from "../eventBus.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * TTL interacts with nack/requeue in a dangerous way: enqueue registers a run in a
 * TTL sorted set for the TTL consumer, and the first dequeue removes that entry
 * ("the run is executing, not expired"). If the run is later nacked back onto the
 * queue with its original (now lapsed) ttlExpiresAt still in the message, the next
 * dequeue pass takes the expired-TTL branch: it removes the run from the queue
 * sorted sets and defers finalization to a TTL consumer that no longer has any
 * entry for the run. The run then exists in no queue structure at all — Postgres
 * says QUEUED forever, and nothing (dequeue, TTL consumer, concurrency sweeper,
 * repair) can ever see it again.
 *
 * These tests lock in the two halves of the fix:
 * 1. nack strips ttlExpiresAt — TTL only applies to runs that have never been
 *    dequeued (the same contract as includeTtl on re-enqueues), so a requeued run
 *    stays dequeuable and is never expired by its original deadline.
 * 2. The dequeue expired-TTL branch re-registers the TTL entry instead of assuming
 *    it exists, so any message still carrying a lapsed ttlExpiresAt with no TTL
 *    entry (e.g. written before the fix) finalizes as EXPIRED instead of orphaning.
 */
describe("RunEngine ttl + nack/requeue", () => {
  containerTest(
    "Heartbeat-stalled run with a lapsed TTL is requeued and dequeued again (not orphaned)",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const executingTimeout = 200;

      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
          processWorkerQueueDebounceMs: 50,
          masterQueueConsumersDisabled: true,
          retryOptions: {
            maxAttempts: 12,
            minTimeoutInMs: 50,
            maxTimeoutInMs: 50,
            factor: 1,
            randomize: false,
          },
          ttlSystem: {
            pollIntervalMs: 100,
            batchSize: 10,
            batchMaxWaitMs: 100,
          },
        },
        runLock: {
          redis: redisOptions,
        },
        machines: {
          defaultMachine: "small-1x",
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
        heartbeatTimeoutsMs: {
          EXECUTING: executingTimeout,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const expiredEvents: EventBusEventArgs<"runExpired">[0][] = [];
        engine.eventBus.on("runExpired", (result) => {
          expiredEvents.push(result);
        });

        const triggeredAt = Date.now();
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_stall1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_stall1",
            spanId: "s_stall1",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            ttl: "1s",
          },
          prisma
        );

        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_stall1",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(1);

        await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("EXECUTING");

        await vi.waitFor(
          async () => {
            const data = await engine.getRunExecutionData({ runId: run.id });
            assertNonNullable(data);
            expect(data.snapshot.executionStatus).toBe("QUEUED");
          },
          { timeout: 10_000, interval: 100 }
        );

        const pastDeadlineMs = triggeredAt + 1_000 + 300 - Date.now();
        if (pastDeadlineMs > 0) {
          await setTimeout(pastDeadlineMs);
        }

        const message = await engine.runQueue.readMessage(
          authenticatedEnvironment.organization.id,
          run.id
        );
        assertNonNullable(message);
        expect(message.ttlExpiresAt).toBeUndefined();

        await engine.runQueue.processMasterQueueForEnvironment(authenticatedEnvironment.id, 10);
        const dequeued2 = await engine.dequeueFromWorkerQueue({
          consumerId: "test_stall1",
          workerQueue: "main",
          blockingPopTimeoutSeconds: 1,
        });
        expect(dequeued2.length).toBe(1);
        expect(dequeued2[0]?.run.id).toBe(run.id);

        expect(expiredEvents.length).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Requeue after a failure strips ttlExpiresAt so later dequeues do not treat the run as expired",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
          processWorkerQueueDebounceMs: 50,
          masterQueueConsumersDisabled: true,
          retryOptions: {
            maxAttempts: 12,
            minTimeoutInMs: 50,
            maxTimeoutInMs: 50,
            factor: 1,
            randomize: false,
          },
          ttlSystem: {
            pollIntervalMs: 100,
            batchSize: 10,
            batchMaxWaitMs: 100,
          },
        },
        runLock: {
          redis: redisOptions,
        },
        machines: {
          defaultMachine: "small-1x",
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
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const expiredEvents: EventBusEventArgs<"runExpired">[0][] = [];
        engine.eventBus.on("runExpired", (result) => {
          expiredEvents.push(result);
        });

        const triggeredAt = Date.now();
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_nack1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_nack1",
            spanId: "s_nack1",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            ttl: "1s",
          },
          prisma
        );

        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_nack1",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(1);

        const nackResult = await engine.runAttemptSystem.tryNackAndRequeue({
          run: { id: run.id },
          environment: {
            id: authenticatedEnvironment.id,
            type: authenticatedEnvironment.type,
          },
          orgId: authenticatedEnvironment.organization.id,
          projectId: authenticatedEnvironment.project.id,
          timestamp: Date.now(),
          error: {
            type: "INTERNAL_ERROR",
            code: "TASK_RUN_DEQUEUED_MAX_RETRIES",
            message: "test requeue",
          },
        });
        expect(nackResult.wasRequeued).toBe(true);

        const message = await engine.runQueue.readMessage(
          authenticatedEnvironment.organization.id,
          run.id
        );
        assertNonNullable(message);
        expect(message.ttlExpiresAt).toBeUndefined();

        const pastDeadlineMs = triggeredAt + 1_000 + 300 - Date.now();
        if (pastDeadlineMs > 0) {
          await setTimeout(pastDeadlineMs);
        }

        await engine.runQueue.processMasterQueueForEnvironment(authenticatedEnvironment.id, 10);
        const dequeued2 = await engine.dequeueFromWorkerQueue({
          consumerId: "test_nack1",
          workerQueue: "main",
          blockingPopTimeoutSeconds: 1,
        });
        expect(dequeued2.length).toBe(1);
        expect(dequeued2[0]?.run.id).toBe(run.id);

        expect(expiredEvents.length).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Dequeue re-registers a lapsed-TTL message for the TTL consumer when its TTL entry is missing",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        worker: {
          disabled: true,
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
          processWorkerQueueDebounceMs: 50,
          masterQueueConsumersDisabled: true,
          ttlSystem: {
            pollIntervalMs: 100,
            batchSize: 10,
            batchMaxWaitMs: 100,
          },
        },
        runLock: {
          redis: redisOptions,
        },
        machines: {
          defaultMachine: "small-1x",
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
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_lostttl1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_lost1",
            spanId: "s_lost1",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            ttl: "1s",
          },
          prisma
        );

        const message = await engine.runQueue.readMessage(
          authenticatedEnvironment.organization.id,
          run.id
        );
        assertNonNullable(message);
        expect(message.ttlExpiresAt).toBeDefined();

        const ttlMember = `${message.queue}|${run.id}|${authenticatedEnvironment.organization.id}`;
        let removed = 0;
        for (let shard = 0; shard < 4; shard++) {
          removed += await engine.runQueue.redis.zrem(
            engine.runQueue.keys.ttlQueueKeyForShard(shard),
            ttlMember
          );
        }
        expect(removed).toBe(1);

        await setTimeout(1_300);

        await engine.runQueue.processMasterQueueForEnvironment(authenticatedEnvironment.id, 10);

        await vi.waitFor(
          async () => {
            const expiredRun = await prisma.taskRun.findUnique({
              where: { id: run.id },
              select: { status: true },
            });
            expect(expiredRun?.status).toBe("EXPIRED");
          },
          { timeout: 15_000, interval: 200 }
        );

        const messageExists = await engine.runQueue.messageExists(
          authenticatedEnvironment.organization.id,
          run.id
        );
        expect(messageExists).toBe(0);

        const envConcurrency =
          await engine.runQueue.currentConcurrencyOfEnvironment(authenticatedEnvironment);
        expect(envConcurrency).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Dequeue re-registers a lapsed-TTL message with a concurrency key when its TTL entry is missing",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        worker: {
          disabled: true,
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: {
          redis: redisOptions,
          processWorkerQueueDebounceMs: 50,
          masterQueueConsumersDisabled: true,
          ttlSystem: {
            pollIntervalMs: 100,
            batchSize: 10,
            batchMaxWaitMs: 100,
          },
        },
        runLock: {
          redis: redisOptions,
        },
        machines: {
          defaultMachine: "small-1x",
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
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_lostttl2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_lost2",
            spanId: "s_lost2",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            ttl: "1s",
            concurrencyKey: "ckA",
          },
          prisma
        );

        const message = await engine.runQueue.readMessage(
          authenticatedEnvironment.organization.id,
          run.id
        );
        assertNonNullable(message);
        expect(message.ttlExpiresAt).toBeDefined();
        expect(message.concurrencyKey).toBeDefined();

        const ttlMember = `${message.queue}|${run.id}|${authenticatedEnvironment.organization.id}`;
        let removed = 0;
        for (let shard = 0; shard < 4; shard++) {
          removed += await engine.runQueue.redis.zrem(
            engine.runQueue.keys.ttlQueueKeyForShard(shard),
            ttlMember
          );
        }
        expect(removed).toBe(1);

        await setTimeout(1_300);

        await engine.runQueue.processMasterQueueForEnvironment(authenticatedEnvironment.id, 10);

        await vi.waitFor(
          async () => {
            const expiredRun = await prisma.taskRun.findUnique({
              where: { id: run.id },
              select: { status: true },
            });
            expect(expiredRun?.status).toBe("EXPIRED");
          },
          { timeout: 15_000, interval: 200 }
        );

        const messageExists = await engine.runQueue.messageExists(
          authenticatedEnvironment.organization.id,
          run.id
        );
        expect(messageExists).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );
});
