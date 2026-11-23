// A retriable snapshot read must reject so the snapshots-since route answers 503; null becomes a 500.
import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
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

async function triggerRun(engine: RunEngine, env: Env, prisma: PrismaClient, n: number) {
  return engine.trigger(
    {
      number: n,
      friendlyId: `run_sinceunavail${n}`,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-sinceunavail${n}`,
      spanId: `s-sinceunavail${n}`,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );
}

async function startRun(engine: RunEngine, env: Env, runId: string) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_sinceunavail",
      workerQueue: "main",
      blockingPopTimeoutSeconds: 1,
    });
    if (dequeued.length > 0) {
      expect(dequeued[0].run.id).toBe(runId);
      return engine.startRunAttempt({ runId, snapshotId: dequeued[0].snapshot.id });
    }
    await setTimeout(50);
  }
  throw new Error("run never reached the worker queue");
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to reject");
}

describe("getSnapshotsSince with the snapshot store unavailable", () => {
  containerTestWithIsolatedRedis(
    "a retriable snapshot read failure rejects with the retriable error instead of resolving null",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 1);
        const attempt = await startRun(engine, env, run.id);
        expect(attempt.snapshot.executionStatus).toBe("EXECUTING");

        const healthy = await engine.getSnapshotsSince({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
        });
        expect(healthy).not.toBeNull();

        // The snapshot store's client goes away; the rest of the engine's Redis is fine.
        await snapshotStore.quit();

        const error = await captureError(() =>
          engine.getSnapshotsSince({ runId: run.id, snapshotId: attempt.snapshot.id })
        );
        expect(error).toBeInstanceOf(SnapshotReadUnavailableError);
        expect(error).not.toBeInstanceOf(SnapshotStateExpiredError);
        expect((error as SnapshotReadUnavailableError).retriable).toBe(true);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "expired snapshot state is not retriable and still resolves null",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 2);
        const cancelled = await engine.cancelRun({ runId: run.id, reason: "stop" });
        expect(cancelled.snapshot.executionStatus).toBe("FINISHED");

        await snapshotStore.dropRun(run.id);
        expect(await snapshotStore.getLatest(run.id)).toBeNull();

        const result = await engine.getSnapshotsSince({
          runId: run.id,
          snapshotId: cancelled.snapshot.id,
        });
        expect(result).toBeNull();
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
});
