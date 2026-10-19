// Cancelling a finished redis-primary run whose MemoryDB snapshot state has aged out (only ever after
// a FINISHED snapshot) must report the run as already finished from the final TaskRun row, rather
// than fail. That covers direct cancels, bulk cancels (membership is still recorded) and the
// recursive child cancel a parent's cancellation enqueues. A transient MemoryDB error must keep
// failing closed. Real Postgres + real Redis, no mocks.
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

async function triggerRun(
  engine: RunEngine,
  env: Env,
  prisma: PrismaClient,
  n: number,
  parentTaskRunId?: string
) {
  return engine.trigger(
    {
      number: n,
      friendlyId: `run_cancelexp${n}`,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-cancelexp${n}`,
      spanId: `s-cancelexp${n}`,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
      parentTaskRunId,
    },
    prisma
  );
}

async function dequeue(engine: RunEngine, env: Env) {
  for (let i = 0; i < 25; i++) {
    await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_cancelexp",
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

async function runToSuccess(engine: RunEngine, env: Env, runId: string) {
  const attempt = await startRun(engine, env, runId);
  const completed = await engine.completeRunAttempt({
    runId,
    snapshotId: attempt.snapshot.id,
    completion: {
      id: runId,
      ok: true,
      output: '{"result":"done"}',
      outputType: "application/json",
    },
  });
  expect(completed.attemptStatus).toBe("RUN_FINISHED");
}

// What the post-finish TTL does: the run's MemoryDB state is gone, the residency marker survives.
async function expire(snapshotStore: RedisSnapshotStore, runId: string) {
  const head = await snapshotStore.getLatest(runId);
  assertNonNullable(head);
  expect(head.entry.executionStatus).toBe("FINISHED");
  await snapshotStore.dropRun(runId);
  expect(await snapshotStore.getLatest(runId)).toBeNull();
  expect(await snapshotStore.readBirthResidency(runId)).toBe("redis-primary");
}

describe("cancelRun with expired redis-primary snapshot state", () => {
  containerTest(
    "an expired COMPLETED_SUCCESSFULLY run is reported as already finished and left unchanged",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 1);
        await runToSuccess(engine, env, run.id);
        const before = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(before.status).toBe("COMPLETED_SUCCESSFULLY");
        await expire(snapshotStore, run.id);

        const result = await engine.cancelRun({ runId: run.id, reason: "stop" });
        expect(result.alreadyFinished).toBe(true);
        expect(result.snapshot).toBeNull();
        expect(result.run.id).toBe(run.id);
        expect(result.run.status).toBe("COMPLETED_SUCCESSFULLY");

        const after = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(after.status).toBe("COMPLETED_SUCCESSFULLY");
        expect(after.completedAt).toEqual(before.completedAt);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "a bulk cancel of an expired finished run records the bulk-action membership",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 2);
        await runToSuccess(engine, env, run.id);
        await expire(snapshotStore, run.id);

        const bulkActionId = "bulk_cancelexp2";
        const result = await engine.cancelRun({ runId: run.id, bulkActionId });
        expect(result.alreadyFinished).toBe(true);
        expect(result.snapshot).toBeNull();

        const persisted = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(persisted.bulkActionGroupIds).toContain(bulkActionId);
        expect(persisted.status).toBe("COMPLETED_SUCCESSFULLY");
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
        const run = await triggerRun(engine, env, prisma, 3);
        await runToSuccess(engine, env, run.id);

        // The snapshot store's MemoryDB client goes away; the rest of the engine's Redis is fine.
        await snapshotStore.quit();

        let error: unknown;
        try {
          await engine.cancelRun({ runId: run.id, reason: "stop" });
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
    "a parent cancel's recursive cancel of an expired finished child does not throw",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);

        // Parent executing; child of the parent runs to success and its state expires.
        const parent = await triggerRun(engine, env, prisma, 4);
        await startRun(engine, env, parent.id);
        const child = await triggerRun(engine, env, prisma, 5, parent.id);
        await runToSuccess(engine, env, child.id);
        await expire(snapshotStore, child.id);

        const childBefore = await prisma.taskRun.findFirstOrThrow({ where: { id: child.id } });
        expect(childBefore.parentTaskRunId).toBe(parent.id);
        expect(childBefore.status).toBe("COMPLETED_SUCCESSFULLY");

        // Finalize the parent so it finishes and enqueues the child cancel job.
        const parentResult = await engine.cancelRun({ runId: parent.id, finalizeRun: true });
        expect(parentResult.alreadyFinished).toBe(false);

        // The real worker's job for the child: acked (gone) only if it succeeded. A thrown error
        // requeues it under the same id with a higher attempt, and exhausted retries dead-letter it.
        const worker = (engine as any).worker;
        const jobId = `cancelRun:${child.id}`;
        expect(
          await worker.getJob(jobId),
          "the parent cancel enqueues the child cancel"
        ).not.toBeNull();
        let job: { attempt: number } | null = null;
        for (let i = 0; i < 30; i++) {
          job = await worker.getJob(jobId);
          if (job === null || job.attempt > 0) break;
          await setTimeout(300);
        }
        expect(job, "the child cancel job must succeed, not be retried").toBeNull();
        expect(await worker.queue.sizeOfDeadLetterQueue()).toBe(0);

        const childRow = await prisma.taskRun.findFirstOrThrow({ where: { id: child.id } });
        expect(childRow.status).toBe("COMPLETED_SUCCESSFULLY");
        expect(childRow.completedAt).toEqual(childBefore.completedAt);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
  containerTest(
    "an EXECUTING run with expired snapshot state fails closed and is left unchanged",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 6);
        await startRun(engine, env, run.id);
        const before = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(before.status).toBe("EXECUTING");

        // Expired state with a non-final row is lost state, not a finished run.
        await snapshotStore.dropRun(run.id);
        expect(await snapshotStore.getLatest(run.id)).toBeNull();
        expect(await snapshotStore.readBirthResidency(run.id)).toBe("redis-primary");

        const bulkActionId = "bulk_cancelexp6";
        let error: unknown;
        try {
          await engine.cancelRun({ runId: run.id, reason: "stop", bulkActionId });
        } catch (e) {
          error = e;
        }
        expect(error).toBeInstanceOf(SnapshotStateExpiredError);

        const after = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(after.status).toBe("EXECUTING");
        expect(after.completedAt).toBeNull();
        expect(after.bulkActionGroupIds).not.toContain(bulkActionId);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
});
