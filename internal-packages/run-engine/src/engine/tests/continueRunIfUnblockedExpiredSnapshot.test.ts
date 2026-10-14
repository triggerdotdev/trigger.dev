// A run cancelled while SUSPENDED on a long wait keeps its blocking edges, so when that waitpoint
// completes days later continueRunIfUnblocked runs for an already-finished run. For a redis-primary run
// the MemoryDB snapshot state has aged out by then (only ever after a FINISHED snapshot): the job must
// skip the run as finished instead of failing on the unservable read. A transient MemoryDB error must
// keep failing closed. Real Postgres + real Redis, no mocks.
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

type Env = Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>;

// The worker is disabled so the continueRunIfUnblocked job that completeWaitpoint enqueues never runs
// in the background; each test invokes waitpointSystem.continueRunIfUnblocked directly instead.
function redisOnlyEngine(prisma: PrismaClient, redisOptions: RedisOptions) {
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
  return { engine, snapshotStore };
}

async function triggerRun(engine: RunEngine, env: Env, prisma: PrismaClient, n: number) {
  return engine.trigger(
    {
      number: n,
      friendlyId: `run_contexp${n}`,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-contexp${n}`,
      spanId: `s-contexp${n}`,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );
}

async function dequeue(engine: RunEngine, env: Env) {
  for (let i = 0; i < 25; i++) {
    await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_contexp",
      workerQueue: "main",
    });
    if (dequeued.length > 0) return dequeued[0];
    await setTimeout(200);
  }
  throw new Error("run never reached the worker queue");
}

// Start the run, block it on a long DATETIME wait, checkpoint it to SUSPENDED, then cancel it. A
// SUSPENDED run is not executing, so cancellation finishes it straight away; its blocking edge stays.
async function cancelWhileSuspendedOnWait(
  engine: RunEngine,
  snapshotStore: RedisSnapshotStore,
  env: Env,
  prisma: PrismaClient,
  n: number
) {
  await setupBackgroundWorker(engine, env, taskIdentifier);
  const run = await triggerRun(engine, env, prisma, n);
  expect(await snapshotStore.readBirthResidency(run.id)).toBe("redis-primary");

  const dequeued = await dequeue(engine, env);
  expect(dequeued.run.id).toBe(run.id);
  await engine.startRunAttempt({ runId: run.id, snapshotId: dequeued.snapshot.id });

  const { waitpoint } = await engine.createDateTimeWaitpoint({
    runId: run.id,
    projectId: env.project.id,
    environmentId: env.id,
    completedAfter: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });
  const blocked = await engine.blockRunWithWaitpoint({
    runId: run.id,
    waitpoints: waitpoint.id,
    projectId: env.project.id,
    organizationId: env.organizationId,
  });
  expect(blocked.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

  const checkpoint = await engine.createCheckpoint({
    runId: run.id,
    snapshotId: blocked.id,
    checkpoint: {
      type: "DOCKER",
      reason: "TEST_CHECKPOINT",
      location: "test-location",
      imageRef: "test-image-ref",
    },
  });
  expect(checkpoint.ok).toBe(true);
  const suspended = checkpoint.ok ? checkpoint.snapshot : null;
  assertNonNullable(suspended);
  expect(suspended.executionStatus).toBe("SUSPENDED");

  const cancelled = await engine.cancelRun({ runId: run.id, reason: "stop" });
  expect(cancelled.snapshot.executionStatus).toBe("FINISHED");
  const row = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
  expect(row.status).toBe("CANCELED");

  return { run, waitpoint };
}

describe("continueRunIfUnblocked with expired redis-primary snapshot state", () => {
  containerTest(
    "a run cancelled while suspended on a wait is skipped as finished once its state has expired",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        const { run, waitpoint } = await cancelWhileSuspendedOnWait(
          engine,
          snapshotStore,
          env,
          prisma,
          1
        );

        // What the post-finish TTL does: the run's MemoryDB state is gone, the residency marker
        // survives.
        const head = await snapshotStore.getLatest(run.id);
        assertNonNullable(head);
        expect(head.entry.executionStatus).toBe("FINISHED");
        await snapshotStore.dropRun(run.id);
        expect(await snapshotStore.getLatest(run.id)).toBeNull();
        expect(await snapshotStore.readBirthResidency(run.id)).toBe("redis-primary");

        // The wait elapses days later: the waitpoint completes and the continuation runs.
        const completed = await engine.completeWaitpoint({ id: waitpoint.id });
        expect(completed.status).toBe("COMPLETED");

        const result = await engine.waitpointSystem.continueRunIfUnblocked({ runId: run.id });
        expect(result).toEqual({ status: "skipped", reason: "run is finished" });
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "a finished run with MemoryDB unavailable still fails closed and retriable",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        const { run, waitpoint } = await cancelWhileSuspendedOnWait(
          engine,
          snapshotStore,
          env,
          prisma,
          2
        );

        const completed = await engine.completeWaitpoint({ id: waitpoint.id });
        expect(completed.status).toBe("COMPLETED");

        // The snapshot store's MemoryDB client goes away; the rest of the engine's Redis is fine.
        await snapshotStore.quit();

        let error: unknown;
        try {
          await engine.waitpointSystem.continueRunIfUnblocked({ runId: run.id });
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
    "an EXECUTING run with expired snapshot state fails closed instead of being skipped",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 3);
        const dequeued = await dequeue(engine, env);
        expect(dequeued.run.id).toBe(run.id);
        await engine.startRunAttempt({ runId: run.id, snapshotId: dequeued.snapshot.id });
        const row = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(row.status).toBe("EXECUTING");

        // Expired state with a non-final row is lost state, not a finished run.
        await snapshotStore.dropRun(run.id);
        expect(await snapshotStore.getLatest(run.id)).toBeNull();
        expect(await snapshotStore.readBirthResidency(run.id)).toBe("redis-primary");

        let error: unknown;
        let result: unknown;
        try {
          result = await engine.waitpointSystem.continueRunIfUnblocked({ runId: run.id });
        } catch (e) {
          error = e;
        }
        expect(result).toBeUndefined();
        expect(error).toBeInstanceOf(SnapshotStateExpiredError);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
});
