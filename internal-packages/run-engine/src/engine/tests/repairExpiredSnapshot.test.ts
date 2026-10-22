// The admin repair path scans a queue's currentConcurrency sets, which is exactly where long-finished
// runs leak. For a redis-primary run whose MemoryDB snapshot state has aged out (only ever after a
// FINISHED snapshot), the snapshot read is permanently unservable: the repair must fall back to the
// final TaskRun row and clear the leaked slot, rather than fail the whole call. A transient MemoryDB
// error must keep failing closed. Real Postgres + real Redis, no mocks.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
import type { RedisOptions } from "@internal/redis";
import type { PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  SnapshotReadUnavailableError,
  SnapshotStateExpiredError,
  TaskRunExecutionSnapshotStore,
} from "@internal/run-store";
import { RunEngine } from "../index.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const taskIdentifier = "test-task";
const queueName = `task/${taskIdentifier}`;

type Env = Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>;

function redisOnlyEngine(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  { repairSnapshotTimeoutMs = 100 }: { repairSnapshotTimeoutMs?: number } = {}
) {
  const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
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
    repairSnapshotTimeoutMs,
    tracer: trace.getTracer("test", "0.0.0"),
  });
  return { engine, snapshotStore };
}

// A run that is cancelled before it is dequeued finishes straight away (a FINISHED snapshot).
async function finishedRun(engine: RunEngine, env: Env, prisma: PrismaClient, n: number) {
  const run = await engine.trigger(
    {
      number: n,
      friendlyId: `run_repairexp${n}`,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-repairexp${n}`,
      spanId: `s-repairexp${n}`,
      workerQueue: "main",
      queue: queueName,
      isTest: false,
      tags: [],
    },
    prisma
  );
  const cancelled = await engine.cancelRun({ runId: run.id, reason: "stop" });
  expect(cancelled.snapshot?.executionStatus).toBe("FINISHED");
  return run;
}

// A run that is dequeued and started: EXECUTING row, live snapshot state, holding its slot.
async function executingRun(engine: RunEngine, env: Env, prisma: PrismaClient, n: number) {
  const run = await engine.trigger(
    {
      number: n,
      friendlyId: `run_repairexp${n}`,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-repairexp${n}`,
      spanId: `s-repairexp${n}`,
      workerQueue: "main",
      queue: queueName,
      isTest: false,
      tags: [],
    },
    prisma
  );
  for (let i = 0; i < 25; i++) {
    await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
    const [dequeued] = await engine.dequeueFromWorkerQueue({
      consumerId: "test_repairexp",
      workerQueue: "main",
    });
    if (dequeued) {
      expect(dequeued.run.id).toBe(run.id);
      await engine.startRunAttempt({ runId: run.id, snapshotId: dequeued.snapshot.id });
      const row = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
      expect(row.status).toBe("EXECUTING");
      expect(await engine.runQueue.getCurrentConcurrencyOfEnvironment(env)).toContain(run.id);
      return run;
    }
    await setTimeout(200);
  }
  throw new Error("run never reached the worker queue");
}

// The leak the repair exists for: a finished run's id left behind in the concurrency sets.
async function leakIntoConcurrencySets(engine: RunEngine, env: Env, runId: string) {
  await engine.runQueue.redis.sadd(engine.runQueue.keys.envCurrentConcurrencyKey(env), runId);
  await engine.runQueue.redis.sadd(
    engine.runQueue.keys.queueCurrentConcurrencyKey(env, queueName),
    runId
  );
  expect(await engine.runQueue.getCurrentConcurrencyOfEnvironment(env)).toContain(runId);
  expect(await engine.runQueue.getCurrentConcurrencyOfQueue(env, queueName)).toContain(runId);
}

// What the post-finish TTL does: the run's MemoryDB state is gone, the residency marker survives.
async function expire(snapshotStore: RedisSnapshotStore, runId: string) {
  await snapshotStore.dropRun(runId);
  expect(await snapshotStore.getLatest(runId)).toBeNull();
  expect(await snapshotStore.readBirthResidency(runId)).toBe("redis-primary");
}

describe("repairEnvironment with expired redis-primary snapshot state", () => {
  containerTest(
    "a dry run reports an expired finished run as a FINISHED repair with no snapshot",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await finishedRun(engine, env, prisma, 1);
        await leakIntoConcurrencySets(engine, env, run.id);
        await expire(snapshotStore, run.id);

        const result = await engine.repairEnvironment(env, true);

        expect(result.runIds).toContain(run.id);
        expect(result.repairs).toContainEqual({
          action: "repairSnapshot",
          runId: run.id,
          snapshotStatus: "FINISHED",
          snapshotId: null,
        });
        // A dry run changes nothing.
        expect(await engine.runQueue.getCurrentConcurrencyOfEnvironment(env)).toContain(run.id);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "a repair clears an expired finished run from the concurrency sets",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await finishedRun(engine, env, prisma, 2);
        await leakIntoConcurrencySets(engine, env, run.id);
        await expire(snapshotStore, run.id);

        await engine.repairEnvironment(env, false);

        // The repairSnapshot job runs on the engine's worker after repairSnapshotTimeoutMs.
        for (let i = 0; i < 50; i++) {
          const envSet = await engine.runQueue.getCurrentConcurrencyOfEnvironment(env);
          if (!envSet.includes(run.id)) break;
          await setTimeout(200);
        }
        expect(await engine.runQueue.getCurrentConcurrencyOfEnvironment(env)).not.toContain(run.id);
        expect(await engine.runQueue.getCurrentConcurrencyOfQueue(env, queueName)).not.toContain(
          run.id
        );
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "a repair queued from a FINISHED snapshot that expires before the job runs still clears the slot",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      // A long enough delay that the state is gone before the queued job runs.
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions, {
        repairSnapshotTimeoutMs: 2_000,
      });
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await finishedRun(engine, env, prisma, 6);
        await leakIntoConcurrencySets(engine, env, run.id);

        // Scheduled while the state is still live: the job carries the real FINISHED snapshot id.
        const result = await engine.repairEnvironment(env, false);
        const [repair] = result.repairs.filter((r) => r.runId === run.id);
        expect(repair).toMatchObject({ action: "repairSnapshot", snapshotStatus: "FINISHED" });
        expect(repair.snapshotId).not.toBeNull();

        await expire(snapshotStore, run.id);

        for (let i = 0; i < 50; i++) {
          const envSet = await engine.runQueue.getCurrentConcurrencyOfEnvironment(env);
          if (!envSet.includes(run.id)) break;
          await setTimeout(200);
        }
        expect(await engine.runQueue.getCurrentConcurrencyOfEnvironment(env)).not.toContain(run.id);
        expect(await engine.runQueue.getCurrentConcurrencyOfQueue(env, queueName)).not.toContain(
          run.id
        );
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "a finished run with MemoryDB unavailable still fails the repair closed and retriable",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await finishedRun(engine, env, prisma, 3);
        await leakIntoConcurrencySets(engine, env, run.id);

        // The snapshot store's MemoryDB client goes away; the rest of the engine's Redis is fine.
        await snapshotStore.quit();

        let error: unknown;
        try {
          await engine.repairEnvironment(env, true);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(SnapshotReadUnavailableError);
        expect(error).not.toBeInstanceOf(SnapshotStateExpiredError);
        expect((error as SnapshotReadUnavailableError).retriable).toBe(true);
      } finally {
        await engine.quit();
      }
    }
  );
  containerTest(
    "an EXECUTING run with expired snapshot state fails the repair closed and keeps its slot",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await executingRun(engine, env, prisma, 4);

        // Expired state with a non-final row is lost state, not a finished run.
        await expire(snapshotStore, run.id);

        let error: unknown;
        try {
          await engine.repairEnvironment(env, false);
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(SnapshotStateExpiredError);
        // No repairSnapshot job was scheduled for the run.
        expect(await (engine as any).worker.getJob(`repair-in-progress-run:${run.id}`)).toBeNull();

        // Past repairSnapshotTimeoutMs: nothing was scheduled to clear the slot.
        await setTimeout(1_000);
        expect(await engine.runQueue.getCurrentConcurrencyOfEnvironment(env)).toContain(run.id);
        expect(await engine.runQueue.getCurrentConcurrencyOfQueue(env, queueName)).toContain(
          run.id
        );
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "a repairSnapshot job for an EXECUTING run with expired snapshot state fails closed",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await executingRun(engine, env, prisma, 5);
        await expire(snapshotStore, run.id);

        // The payload #repairRun schedules for an expired finished run.
        const worker = (engine as any).worker;
        const jobId = `repair-in-progress-run:${run.id}`;
        await worker.enqueueOnce({
          id: jobId,
          job: "repairSnapshot",
          payload: { runId: run.id, snapshotId: null, executionStatus: "FINISHED" },
          availableAt: new Date(),
        });

        // A job that throws is requeued under the same id with a higher attempt; one that succeeds
        // is acked and gone.
        let job: { attempt: number } | null = null;
        for (let i = 0; i < 50; i++) {
          job = await worker.getJob(jobId);
          if (job === null || job.attempt > 0) break;
          await setTimeout(200);
        }
        expect(job, "the repair job must fail, not be acked").not.toBeNull();
        assertNonNullable(job);
        expect(job.attempt).toBeGreaterThan(0);

        expect(await engine.runQueue.getCurrentConcurrencyOfEnvironment(env)).toContain(run.id);
        expect(await engine.runQueue.getCurrentConcurrencyOfQueue(env, queueName)).toContain(
          run.id
        );
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
});
