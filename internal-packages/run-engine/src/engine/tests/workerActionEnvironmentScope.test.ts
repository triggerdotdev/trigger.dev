import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { RedisOptions } from "@internal/redis";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  TaskRunExecutionSnapshotStore,
  type RunStore,
} from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { LatestExecutionSnapshotNotFoundError } from "../errors.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const taskIdentifier = "test-task";
const EXECUTING_HEARTBEAT_MS = 600_000;
const OTHER_ENVIRONMENT_ID = "env_not_the_runs_environment";

type Env = Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>;

function createEngine(prisma: PrismaClient, redisOptions: RedisOptions, store?: RunStore) {
  return new RunEngine({
    prisma,
    store,
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
}

function createRedisPrimaryEngine(prisma: PrismaClient, redisOptions: RedisOptions) {
  const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const store = new TaskRunExecutionSnapshotStore(delegate, {
    store: snapshotStore,
    mode: "redis-only",
    logicalRunStoreRoute: "logical:1",
    resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
  });
  return { engine: createEngine(prisma, redisOptions, store), snapshotStore };
}

async function startExecutingRun(engine: RunEngine, env: Env, prisma: PrismaClient, n: number) {
  await setupBackgroundWorker(engine, env, taskIdentifier);
  const run = await engine.trigger(
    {
      number: n,
      friendlyId: `run_envscope${n}`,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-envscope${n}`,
      spanId: `s-envscope${n}`,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );

  for (let i = 0; i < 25; i++) {
    await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_envscope",
      workerQueue: "main",
    });
    if (dequeued.length > 0) {
      assertNonNullable(dequeued[0]);
      expect(dequeued[0].run.id).toBe(run.id);
      const attempt = await engine.startRunAttempt({
        runId: run.id,
        snapshotId: dequeued[0].snapshot.id,
      });
      return { run, attempt };
    }
    await setTimeout(200);
  }
  throw new Error("run never reached the worker queue");
}

async function startRedisPrimaryExecutingRun(
  engine: RunEngine,
  snapshotStore: RedisSnapshotStore,
  env: Env,
  prisma: PrismaClient,
  n: number
) {
  const started = await startExecutingRun(engine, env, prisma, n);
  expect(started.attempt.snapshot.executionStatus).toBe("EXECUTING");
  expect((await snapshotStore.getLatest(started.run.id))?.id).toBe(started.attempt.snapshot.id);
  expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: started.run.id } })).toBe(0);
  return started;
}

async function heartbeatDeadline(engine: RunEngine, runId: string): Promise<number> {
  const job = await engine["worker"].getJob(`heartbeatSnapshot.${runId}`);
  assertNonNullable(job);
  return job.timestamp.getTime();
}

async function pullHeartbeatDeadlineClose(engine: RunEngine, runId: string): Promise<number> {
  await engine["worker"].reschedule(`heartbeatSnapshot.${runId}`, new Date(Date.now() + 60_000));
  const deadline = await heartbeatDeadline(engine, runId);
  expect(deadline).toBeLessThan(Date.now() + 120_000);
  return deadline;
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to reject");
}

describe("worker action environment scope", () => {
  containerTest(
    "heartbeat with the run's environment extends the heartbeat",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);
      try {
        const { run, attempt } = await startExecutingRun(engine, env, prisma, 1);
        expect(attempt.snapshot.executionStatus).toBe("EXECUTING");

        await pullHeartbeatDeadlineClose(engine, run.id);
        const called = Date.now();
        const result = await engine.heartbeatRun({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          environmentId: env.id,
        });

        expect(result.snapshot.id).toBe(attempt.snapshot.id);
        expect(await heartbeatDeadline(engine, run.id)).toBeGreaterThanOrEqual(
          called + EXECUTING_HEARTBEAT_MS
        );
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "heartbeat with another environment reads as not found and extends nothing",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);
      try {
        const { run, attempt } = await startExecutingRun(engine, env, prisma, 2);

        const before = await pullHeartbeatDeadlineClose(engine, run.id);
        const error = await captureError(() =>
          engine.heartbeatRun({
            runId: run.id,
            snapshotId: attempt.snapshot.id,
            environmentId: OTHER_ENVIRONMENT_ID,
          })
        );

        expect(error).toBeInstanceOf(LatestExecutionSnapshotNotFoundError);
        expect(await heartbeatDeadline(engine, run.id)).toBe(before);

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.id).toBe(attempt.snapshot.id);
        expect(executionData.snapshot.executionStatus).toBe("EXECUTING");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "createCheckpoint with another environment reads as not found and writes no checkpoint",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);
      try {
        const { run } = await startExecutingRun(engine, env, prisma, 3);

        const waitpoint = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });
        const blocked = await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.waitpoint.id,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });
        expect(blocked.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        const error = await captureError(() =>
          engine.createCheckpoint({
            runId: run.id,
            snapshotId: blocked.id,
            environmentId: OTHER_ENVIRONMENT_ID,
            checkpoint: {
              type: "DOCKER",
              reason: "TEST_CHECKPOINT",
              location: "test-location",
              imageRef: "test-image-ref",
            },
          })
        );

        expect(error).toBeInstanceOf(LatestExecutionSnapshotNotFoundError);
        expect(await prisma.taskRunCheckpoint.count({ where: { projectId: env.projectId } })).toBe(
          0
        );
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.id).toBe(blocked.id);
        expect(executionData.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
        expect(executionData.checkpoint).toBeUndefined();
      } finally {
        await engine.quit();
      }
    }
  );
});

describe("worker action environment scope with a redis-primary snapshot store", () => {
  containerTest(
    "heartbeat with the run's environment extends the heartbeat",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = createRedisPrimaryEngine(prisma, redisOptions);
      try {
        const { run, attempt } = await startRedisPrimaryExecutingRun(
          engine,
          snapshotStore,
          env,
          prisma,
          11
        );

        await pullHeartbeatDeadlineClose(engine, run.id);
        const called = Date.now();
        const result = await engine.heartbeatRun({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          environmentId: env.id,
        });

        expect(result.snapshot.id).toBe(attempt.snapshot.id);
        expect(await heartbeatDeadline(engine, run.id)).toBeGreaterThanOrEqual(
          called + EXECUTING_HEARTBEAT_MS
        );
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "heartbeat with another environment reads as not found and extends nothing",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = createRedisPrimaryEngine(prisma, redisOptions);
      try {
        const { run, attempt } = await startRedisPrimaryExecutingRun(
          engine,
          snapshotStore,
          env,
          prisma,
          12
        );

        const before = await pullHeartbeatDeadlineClose(engine, run.id);
        const error = await captureError(() =>
          engine.heartbeatRun({
            runId: run.id,
            snapshotId: attempt.snapshot.id,
            environmentId: OTHER_ENVIRONMENT_ID,
          })
        );

        expect(error).toBeInstanceOf(LatestExecutionSnapshotNotFoundError);
        expect(await heartbeatDeadline(engine, run.id)).toBe(before);
        expect((await snapshotStore.getLatest(run.id))?.id).toBe(attempt.snapshot.id);
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("EXECUTING");
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "createCheckpoint with another environment reads as not found and writes no checkpoint",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = createRedisPrimaryEngine(prisma, redisOptions);
      try {
        const { run, attempt } = await startRedisPrimaryExecutingRun(
          engine,
          snapshotStore,
          env,
          prisma,
          13
        );

        const error = await captureError(() =>
          engine.createCheckpoint({
            runId: run.id,
            snapshotId: attempt.snapshot.id,
            environmentId: OTHER_ENVIRONMENT_ID,
            checkpoint: {
              type: "DOCKER",
              reason: "TEST_CHECKPOINT",
              location: "test-location",
              imageRef: "test-image-ref",
            },
          })
        );

        expect(error).toBeInstanceOf(LatestExecutionSnapshotNotFoundError);
        expect(await prisma.taskRunCheckpoint.count({ where: { projectId: env.projectId } })).toBe(
          0
        );
        expect((await snapshotStore.getLatest(run.id))?.id).toBe(attempt.snapshot.id);
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("EXECUTING");
        expect(executionData.checkpoint).toBeUndefined();
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(0);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
});
