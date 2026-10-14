// A late triggerAndWait on a finished redis-primary run lazily creates its associated waitpoint. Once
// the run's MemoryDB snapshot state has aged out (only ever after a FINISHED snapshot), the snapshot
// read is permanently unservable: the engine must fall back to the final TaskRun row and complete the
// waitpoint, rather than fail. A live run that is still winding down (PENDING_CANCEL) must NOT be
// treated as finished, and a transient MemoryDB error must keep failing closed. Real Postgres + real
// Redis, no mocks.
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
  const run = await engine.trigger(
    {
      number: n,
      friendlyId: `run_expired${n}`,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-expired${n}`,
      spanId: `s-expired${n}`,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );
  return run;
}

async function dequeue(engine: RunEngine, env: Env) {
  for (let i = 0; i < 25; i++) {
    await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_expired",
      workerQueue: "main",
    });
    if (dequeued.length > 0) return dequeued[0];
    await setTimeout(200);
  }
  throw new Error("run never reached the worker queue");
}

async function startRun(engine: RunEngine, env: Env, runId: string) {
  const dequeued = await dequeue(engine, env);
  expect(dequeued.run.id).toBe(runId);
  return engine.startRunAttempt({ runId, snapshotId: dequeued.snapshot.id });
}

async function expectFinishedHead(snapshotStore: RedisSnapshotStore, runId: string) {
  const head = await snapshotStore.getLatest(runId);
  assertNonNullable(head);
  expect(head.entry.executionStatus).toBe("FINISHED");
}

// What the post-finish TTL does: the run's MemoryDB state is gone, the residency marker survives.
async function expire(snapshotStore: RedisSnapshotStore, runId: string) {
  await snapshotStore.dropRun(runId);
  expect(await snapshotStore.getLatest(runId)).toBeNull();
  expect(await snapshotStore.readBirthResidency(runId)).toBe("redis-primary");
}

describe("getOrCreateRunWaitpoint with expired redis-primary snapshot state", () => {
  containerTest(
    "an expired COMPLETED_SUCCESSFULLY run returns a completed waitpoint with the run's output",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 1);
        expect(await snapshotStore.readBirthResidency(run.id)).toBe("redis-primary");

        const attempt = await startRun(engine, env, run.id);
        const completed = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          completion: {
            id: run.id,
            ok: true,
            output: '{"result":"done"}',
            outputType: "application/json",
          },
        });
        expect(completed.attemptStatus).toBe("RUN_FINISHED");
        await expectFinishedHead(snapshotStore, run.id);
        await expire(snapshotStore, run.id);

        const waitpoint = await engine.getOrCreateRunWaitpoint({
          runId: run.id,
          projectId: env.project.id,
          environmentId: env.id,
        });
        expect(waitpoint.status).toBe("COMPLETED");
        expect(waitpoint.output).toBe('{"result":"done"}');
        expect(waitpoint.outputType).toBe("application/json");
        expect(waitpoint.outputIsError).toBe(false);

        const linked = await prisma.taskRun.findFirstOrThrow({
          where: { id: run.id },
          include: { associatedWaitpoint: true },
        });
        expect(linked.associatedWaitpoint?.id).toBe(waitpoint.id);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "an expired CANCELED run returns a completed waitpoint with an error output",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 2);

        // Not executing, so cancellation finishes the run straight away.
        const cancelled = await engine.cancelRun({ runId: run.id, reason: "stop" });
        expect(cancelled.snapshot.executionStatus).toBe("FINISHED");
        await expectFinishedHead(snapshotStore, run.id);
        await expire(snapshotStore, run.id);

        const waitpoint = await engine.getOrCreateRunWaitpoint({
          runId: run.id,
          projectId: env.project.id,
          environmentId: env.id,
        });
        expect(waitpoint.status).toBe("COMPLETED");
        expect(waitpoint.outputIsError).toBe(true);
        assertNonNullable(waitpoint.output);
        expect(JSON.parse(waitpoint.output)).toMatchObject({ type: "STRING_ERROR", raw: "stop" });
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "a live CANCELED run still winding down (PENDING_CANCEL) returns a pending waitpoint",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 3);
        await startRun(engine, env, run.id);

        const cancelled = await engine.cancelRun({ runId: run.id, reason: "stop" });
        expect(cancelled.snapshot.executionStatus).toBe("PENDING_CANCEL");
        const row = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(row.status).toBe("CANCELED");

        const waitpoint = await engine.getOrCreateRunWaitpoint({
          runId: run.id,
          projectId: env.project.id,
          environmentId: env.id,
        });
        expect(waitpoint.status).toBe("PENDING");
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
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 4);
        const cancelled = await engine.cancelRun({ runId: run.id, reason: "stop" });
        expect(cancelled.snapshot.executionStatus).toBe("FINISHED");

        // The snapshot store's MemoryDB client goes away; the rest of the engine's Redis is fine.
        await snapshotStore.quit();

        let error: unknown;
        try {
          await engine.getOrCreateRunWaitpoint({
            runId: run.id,
            projectId: env.project.id,
            environmentId: env.id,
          });
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(SnapshotReadUnavailableError);
        expect(error).not.toBeInstanceOf(SnapshotStateExpiredError);
        expect((error as SnapshotReadUnavailableError).retriable).toBe(true);

        const row = await prisma.taskRun.findFirstOrThrow({
          where: { id: run.id },
          include: { associatedWaitpoint: true },
        });
        expect(row.associatedWaitpoint).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );
  containerTest(
    "an EXECUTING run with expired snapshot state fails closed and creates no waitpoint",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 5);
        await startRun(engine, env, run.id);
        const before = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(before.status).toBe("EXECUTING");

        // Expired state with a non-final row is lost state, not a finished run.
        await expire(snapshotStore, run.id);

        let error: unknown;
        try {
          await engine.getOrCreateRunWaitpoint({
            runId: run.id,
            projectId: env.project.id,
            environmentId: env.id,
          });
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(SnapshotStateExpiredError);

        const row = await prisma.taskRun.findFirstOrThrow({
          where: { id: run.id },
          include: { associatedWaitpoint: true },
        });
        expect(row.associatedWaitpoint).toBeNull();
        expect(row.status).toBe("EXECUTING");
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
});
