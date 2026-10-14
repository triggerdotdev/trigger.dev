// A stale worker-queue message can outlive a finished redis-primary run. Once the run's MemoryDB
// snapshot state has aged out (only ever after a FINISHED snapshot), dequeueing that message must
// remove it from the queue rather than nack it round and round until it dead-letters. A transient
// MemoryDB error must keep the existing nack behaviour. Real Postgres + real Redis, no mocks.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
import type { RedisOptions } from "@internal/redis";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  TaskRunExecutionSnapshotStore,
} from "@internal/run-store";
import { RunEngine } from "../index.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const taskIdentifier = "test-task";

type Env = Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>;

function redisOnlyEngine(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  { beforeCommand }: { beforeCommand?: (operation: string) => Promise<void> } = {}
) {
  const snapshotStore = new RedisSnapshotStore({
    redisOptions,
    completedTtlMs: 60_000,
    beforeCommand,
  });
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const engine = new RunEngine({
    prisma,
    store: new TaskRunExecutionSnapshotStore(delegate, {
      store: snapshotStore,
      mode: "redis-only",
      logicalRunStoreRoute: "logical:1",
      resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
    }),
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
  return { engine, snapshotStore };
}

async function dequeue(engine: RunEngine, env: Env) {
  for (let i = 0; i < 25; i++) {
    await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_dequeue_expired",
      workerQueue: "main",
    });
    if (dequeued.length > 0) return dequeued[0];
    await setTimeout(200);
  }
  throw new Error("run never reached the worker queue");
}

type QueueMessage = NonNullable<Awaited<ReturnType<RunEngine["runQueue"]["readMessage"]>>>;

/**
 * Runs a run to FINISHED and returns the queue message it was dequeued with, captured before the
 * completion acked it, so the test can put that same message back on the queue as a stale copy.
 */
async function finishRunCapturingMessage(engine: RunEngine, env: Env, prisma: PrismaClient) {
  await setupBackgroundWorker(engine, env, taskIdentifier);
  const run = await engine.trigger(
    {
      number: 1,
      friendlyId: "run_dqexpired1",
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t-dqexpired1",
      spanId: "s-dqexpired1",
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );

  const dequeued = await dequeue(engine, env);
  expect(dequeued.run.id).toBe(run.id);

  const message = await engine.runQueue.readMessage(env.organizationId, run.id);
  assertNonNullable(message);

  const attempt = await engine.startRunAttempt({
    runId: run.id,
    snapshotId: dequeued.snapshot.id,
  });
  const completed = await engine.completeRunAttempt({
    runId: run.id,
    snapshotId: attempt.snapshot.id,
    completion: { id: run.id, ok: true, output: '{"ok":true}', outputType: "application/json" },
  });
  expect(completed.attemptStatus).toBe("RUN_FINISHED");

  const row = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
  expect(row.status).toBe("COMPLETED_SUCCESSFULLY");
  // Completion acknowledged the original message.
  expect(await engine.runQueue.readMessage(env.organizationId, run.id)).toBeUndefined();

  return { runId: run.id, message };
}

/** Puts the stale message back on the run queue the same way the route-less recovery test does. */
async function requeueStale(engine: RunEngine, env: Env, message: QueueMessage) {
  await engine.runQueue.enqueueMessage({
    env,
    workerQueue: "main",
    // The stored message carries the full queue key; enqueueMessage expects the queue name.
    message: { ...message, queue: `task/${taskIdentifier}` },
    enableFastPath: true,
  });
  const stale = await engine.runQueue.readMessage(env.organizationId, message.runId);
  assertNonNullable(stale);
  return stale;
}

/**
 * Dequeues until the stale message has been handled: either acknowledged (gone) or nacked (its
 * attempt count moved). Returns everything the dequeue calls returned.
 */
async function dequeueStale(engine: RunEngine, env: Env, runId: string, attempt: number) {
  const results: Awaited<ReturnType<RunEngine["dequeueFromWorkerQueue"]>> = [];
  for (let i = 0; i < 25; i++) {
    await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
    results.push(
      ...(await engine.dequeueFromWorkerQueue({
        consumerId: "test_dequeue_expired",
        workerQueue: "main",
      }))
    );
    const current = await engine.runQueue.readMessage(env.organizationId, runId);
    if (!current || current.attempt !== attempt) {
      return { results, current };
    }
    await setTimeout(200);
  }
  throw new Error("the stale message was never dequeued");
}

/** A freshly triggered run: PENDING row, QUEUED snapshot, its message on the run queue. */
async function triggerPendingRun(engine: RunEngine, env: Env, prisma: PrismaClient, n: number) {
  const run = await engine.trigger(
    {
      number: n,
      friendlyId: `run_dqexpired${n}`,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-dqexpired${n}`,
      spanId: `s-dqexpired${n}`,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );
  const row = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
  expect(row.status).toBe("PENDING");
  return run;
}

describe("dequeueFromWorkerQueue with expired redis-primary snapshot state", () => {
  containerTest(
    "a stale message for a finished run with expired snapshot state is removed from the queue",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        const { runId, message } = await finishRunCapturingMessage(engine, env, prisma);

        // What the post-finish TTL does: the run's MemoryDB state is gone, the residency marker survives.
        await snapshotStore.dropRun(runId);
        expect(await snapshotStore.getLatest(runId)).toBeNull();
        expect(await snapshotStore.readBirthResidency(runId)).toBe("redis-primary");

        const stale = await requeueStale(engine, env, message);
        const { results, current } = await dequeueStale(engine, env, runId, stale.attempt);

        expect(results).toEqual([]);
        expect(current, "the stale message must be acknowledged, not nacked").toBeUndefined();
        expect(await engine.runQueue.lengthOfEnvQueue(env)).toBe(0);
        expect(await engine.runQueue.currentConcurrencyOfEnvironment(env)).toBe(0);

        const row = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
        expect(row.status).toBe("COMPLETED_SUCCESSFULLY");
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "a stale message for a finished run with MemoryDB unavailable is nacked, not removed",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        const { runId, message } = await finishRunCapturingMessage(engine, env, prisma);

        // The snapshot store's MemoryDB client goes away; the rest of the engine's Redis is fine.
        await snapshotStore.quit();

        const stale = await requeueStale(engine, env, message);
        const { results, current } = await dequeueStale(engine, env, runId, stale.attempt);

        expect(results).toEqual([]);
        assertNonNullable(current);
        expect(current.attempt, "the stale message must be nacked").toBe(stale.attempt + 1);
        expect(await engine.runQueue.lengthOfEnvQueue(env)).toBe(1);

        const row = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
        expect(row.status).toBe("COMPLETED_SUCCESSFULLY");
      } finally {
        await engine.quit();
      }
    }
  );
  containerTest(
    "a queued message for a PENDING run with expired snapshot state is nacked, not removed",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      // Records the snapshot store's commands, so the test can see how the dequeue read resolved.
      let recording = false;
      const commands: string[] = [];
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions, {
        beforeCommand: async (operation) => {
          if (recording) commands.push(operation);
        },
      });
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerPendingRun(engine, env, prisma, 2);

        // Expired state with a non-final row is lost state, not a finished run.
        await snapshotStore.dropRun(run.id);
        expect(await snapshotStore.getLatest(run.id)).toBeNull();
        expect(await snapshotStore.readBirthResidency(run.id)).toBe("redis-primary");

        recording = true;

        const queued = await engine.runQueue.readMessage(env.organizationId, run.id);
        assertNonNullable(queued);
        const { results, current } = await dequeueStale(engine, env, run.id, queued.attempt);

        expect(results).toEqual([]);
        // The read found no run state and fell through to the pending-state check (the expired
        // path), never to a head read of live state.
        expect(commands).toContain("readPendingState");
        expect(commands).not.toContain("getLatest");
        // Not acknowledged: the message is still queued, with its attempt moved by the nack.
        assertNonNullable(current);
        expect(current.attempt, "the message must be nacked").toBe(queued.attempt + 1);
        expect(await engine.runQueue.lengthOfEnvQueue(env)).toBe(1);

        const row = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(row.status).toBe("PENDING");
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "the recovery re-read of a PENDING run with expired snapshot state nacks, not removes",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      // The lock-body read fails with a non-expiry error, so only the recovery re-read sees expiry.
      // The residency resolver's first command is the state-version read; a MemoryDB error there
      // resolves to an unavailable read, never to expiry.
      let failNextStateVersionRead = false;
      let injected = 0;
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions, {
        beforeCommand: async (operation) => {
          if (failNextStateVersionRead && operation === "readStateVersion") {
            failNextStateVersionRead = false;
            injected++;
            throw new Error("simulated transient read failure");
          }
        },
      });
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerPendingRun(engine, env, prisma, 3);
        await snapshotStore.dropRun(run.id);
        expect(await snapshotStore.getLatest(run.id)).toBeNull();
        failNextStateVersionRead = true;

        const queued = await engine.runQueue.readMessage(env.organizationId, run.id);
        assertNonNullable(queued);
        const { results, current } = await dequeueStale(engine, env, run.id, queued.attempt);

        expect(results).toEqual([]);
        assertNonNullable(current);
        expect(current.attempt, "the message must be nacked").toBe(queued.attempt + 1);
        expect(injected, "only the lock-body read fails").toBe(1);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
});
