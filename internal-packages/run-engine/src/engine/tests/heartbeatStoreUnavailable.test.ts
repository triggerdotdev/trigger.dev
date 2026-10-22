// A runner heartbeat for a redis-primary run reads the latest snapshot from MemoryDB. If MemoryDB is
// briefly unavailable, the heartbeat must still extend the run's heartbeat job, otherwise an outage
// longer than the EXECUTING heartbeat timeout stalls (and crashes) every live run once MemoryDB is
// back. Expired state for a finished run is not an outage and must not extend anything. Real
// Postgres + real Redis, no mocks.
import { containerTest } from "@internal/testcontainers";
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
const EXECUTING_HEARTBEAT_MS = 600_000;

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
    heartbeatTimeoutsMs: { EXECUTING: EXECUTING_HEARTBEAT_MS },
    tracer: trace.getTracer("test", "0.0.0"),
  });
  return { engine, snapshotStore };
}

async function triggerRun(engine: RunEngine, env: Env, prisma: PrismaClient, n: number) {
  return engine.trigger(
    {
      number: n,
      friendlyId: `run_hbunavail${n}`,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-hbunavail${n}`,
      spanId: `s-hbunavail${n}`,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );
}

async function startRun(engine: RunEngine, env: Env, runId: string) {
  for (let i = 0; i < 25; i++) {
    await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_hbunavail",
      workerQueue: "main",
    });
    if (dequeued.length > 0) {
      expect(dequeued[0].run.id).toBe(runId);
      return engine.startRunAttempt({ runId, snapshotId: dequeued[0].snapshot.id });
    }
    await setTimeout(200);
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

describe("heartbeatRun with the snapshot store unavailable", () => {
  containerTest(
    "an EXECUTING run's heartbeat job is still extended when MemoryDB is unavailable, and the call still fails",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 1);
        const attempt = await startRun(engine, env, run.id);
        expect(attempt.snapshot.executionStatus).toBe("EXECUTING");

        const worker = (engine as any).worker;
        const jobId = `heartbeatSnapshot.${run.id}`;
        // Pull the heartbeat deadline close, so any extension is unambiguous.
        await worker.reschedule(jobId, new Date(Date.now() + 5_000));
        const before = await worker.getJob(jobId);
        expect(before).not.toBeNull();
        expect(before.timestamp.getTime()).toBeLessThan(Date.now() + 10_000);

        // The snapshot store's MemoryDB client goes away; the rest of the engine's Redis is fine.
        await snapshotStore.quit();

        const called = Date.now();
        const error = await captureError(() =>
          engine.heartbeatRun({ runId: run.id, snapshotId: attempt.snapshot.id })
        );
        expect(error).toBeInstanceOf(SnapshotReadUnavailableError);
        expect(error).not.toBeInstanceOf(SnapshotStateExpiredError);
        expect((error as SnapshotReadUnavailableError).retriable).toBe(true);

        const after = await worker.getJob(jobId);
        expect(after).not.toBeNull();
        expect(after.timestamp.getTime()).toBeGreaterThanOrEqual(called + EXECUTING_HEARTBEAT_MS);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a finished run with expired snapshot state is not extended",
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

        const reschedule = vi.spyOn((engine as any).worker, "reschedule");
        const error = await captureError(() =>
          engine.heartbeatRun({ runId: run.id, snapshotId: cancelled.snapshot.id })
        );
        expect(error).toBeInstanceOf(SnapshotStateExpiredError);
        expect(reschedule).not.toHaveBeenCalled();
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "a healthy store extends the heartbeat exactly once",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 3);
        const attempt = await startRun(engine, env, run.id);

        const reschedule = vi.spyOn((engine as any).worker, "reschedule");
        const called = Date.now();
        const result = await engine.heartbeatRun({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
        });
        expect(result.snapshot.id).toBe(attempt.snapshot.id);
        expect(reschedule).toHaveBeenCalledTimes(1);
        const [jobId, availableAt] = reschedule.mock.calls[0] as [string, Date];
        expect(jobId).toBe(`heartbeatSnapshot.${run.id}`);
        expect(availableAt.getTime()).toBeGreaterThanOrEqual(called + EXECUTING_HEARTBEAT_MS);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
});
