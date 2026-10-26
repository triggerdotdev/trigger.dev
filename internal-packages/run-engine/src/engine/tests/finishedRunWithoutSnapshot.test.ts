// A finished run with no execution snapshot anywhere reads as already finished. A run created already
// failed is born that way in every mode. A non-final run with no snapshot must keep throwing.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { createRedisClient, type RedisOptions } from "@internal/redis";
import { setTimeout } from "node:timers/promises";
import type { PrismaClient } from "@trigger.dev/database";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  TaskRunExecutionSnapshotStore,
  residencyKey,
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

async function createPreFailedRun(engine: RunEngine, env: Env) {
  return engine.createFailedTaskRun({
    friendlyId: generateFriendlyId("run"),
    environment: {
      id: env.id,
      type: env.type,
      project: { id: env.project.id },
      organization: { id: env.organization.id },
    },
    taskIdentifier,
    payload: "{}",
    payloadType: "application/json",
    error: {
      type: "INTERNAL_ERROR",
      code: "BATCH_ITEM_COULD_NOT_TRIGGER",
      message: "snapshot store unavailable",
    },
  });
}

async function triggerRun(
  engine: RunEngine,
  env: Env,
  prisma: PrismaClient,
  n: number,
  delayUntil?: Date
) {
  return engine.trigger(
    {
      number: n,
      friendlyId: `run_nosnap${n}`,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-nosnap${n}`,
      spanId: `s-nosnap${n}`,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
      delayUntil,
    },
    prisma
  );
}

async function startRun(engine: RunEngine, env: Env, runId: string) {
  for (let i = 0; i < 25; i++) {
    await engine.runQueue.processMasterQueueForEnvironment(env.id, 5);
    const dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_nosnap",
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

async function dropAllSnapshotState(
  snapshotStore: RedisSnapshotStore,
  redisOptions: RedisOptions,
  runId: string
) {
  await snapshotStore.dropRun(runId);
  const redis = createRedisClient(redisOptions);
  try {
    await redis.del(residencyKey(runId));
  } finally {
    await redis.quit();
  }
}

async function expectNoSnapshotAnywhere(
  prisma: PrismaClient,
  snapshotStore: RedisSnapshotStore,
  runId: string
) {
  expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId } })).toBe(0);
  expect(await snapshotStore.getLatest(runId)).toBeNull();
  expect(await snapshotStore.readBirthResidency(runId)).toBeUndefined();
}

async function captureError(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("finished run with no execution snapshot", () => {
  containerTest(
    "cancelRun on a pre-failed run with no snapshot reports it already finished and records bulk membership",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        const failed = await createPreFailedRun(engine, env);
        expect(failed.status).toBe("SYSTEM_FAILURE");
        await expectNoSnapshotAnywhere(prisma, snapshotStore, failed.id);

        const bulkActionId = "bulk_nosnap1";
        const result = await engine.cancelRun({ runId: failed.id, reason: "stop", bulkActionId });
        expect(result.alreadyFinished).toBe(true);
        expect(result.snapshot).toBeNull();
        expect(result.run.id).toBe(failed.id);
        expect(result.run.status).toBe("SYSTEM_FAILURE");

        const after = await prisma.taskRun.findFirstOrThrow({ where: { id: failed.id } });
        expect(after.status).toBe("SYSTEM_FAILURE");
        expect(after.completedAt).toEqual(failed.completedAt);
        expect(after.bulkActionGroupIds).toContain(bulkActionId);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "the engine-worker cancelRun job for a pre-failed run succeeds instead of retrying",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        const failed = await createPreFailedRun(engine, env);
        await expectNoSnapshotAnywhere(prisma, snapshotStore, failed.id);

        const worker = (engine as any).worker;
        const jobId = `cancelRun:${failed.id}`;
        await worker.enqueue({
          id: jobId,
          job: "cancelRun",
          payload: { runId: failed.id, completedAt: new Date(), reason: "stop" },
        });
        let job: { attempt: number } | null = null;
        for (let i = 0; i < 30; i++) {
          job = await worker.getJob(jobId);
          if (job === null || job.attempt > 0) break;
          await setTimeout(300);
        }
        expect(job, "the cancelRun job must succeed, not be retried").toBeNull();
        expect(await worker.queue.sizeOfDeadLetterQueue()).toBe(0);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "cancelRun on a triggered run whose snapshot state is gone and row is SYSTEM_FAILURE reports it already finished",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 3);
        await dropAllSnapshotState(snapshotStore, redisOptions, run.id);
        await prisma.taskRun.update({
          where: { id: run.id },
          data: { status: "SYSTEM_FAILURE", completedAt: new Date() },
        });
        await expectNoSnapshotAnywhere(prisma, snapshotStore, run.id);

        const result = await engine.cancelRun({ runId: run.id, reason: "stop" });
        expect(result.alreadyFinished).toBe(true);
        expect(result.snapshot).toBeNull();
        expect(result.run.status).toBe("SYSTEM_FAILURE");
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  containerTest(
    "cancelRun on an EXECUTING run with no snapshot still throws and leaves the run unchanged",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 4);
        await startRun(engine, env, run.id);
        await dropAllSnapshotState(snapshotStore, redisOptions, run.id);
        await expectNoSnapshotAnywhere(prisma, snapshotStore, run.id);
        const before = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(before.status).toBe("EXECUTING");

        const bulkActionId = "bulk_nosnap4";
        const error = await captureError(() =>
          engine.cancelRun({ runId: run.id, reason: "stop", bulkActionId })
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(`No execution snapshot found for TaskRun ${run.id}`);

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

  containerTest(
    "ensureRunFinalized on a pre-failed run with no snapshot completes",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        const failed = await createPreFailedRun(engine, env);
        await expectNoSnapshotAnywhere(prisma, snapshotStore, failed.id);

        await engine.runAttemptSystem.ensureRunFinalized({ runId: failed.id });
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  for (const state of ["absent", "expired"] as const) {
    containerTest(
      `ensureRunFinalized on a CANCELED run with ${state} snapshot state delivers without deferring`,
      async ({ prisma, redisOptions }) => {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
        try {
          await setupBackgroundWorker(engine, env, taskIdentifier);
          const run = await triggerRun(engine, env, prisma, state === "absent" ? 5 : 6);
          const cancelled = await engine.cancelRun({ runId: run.id, reason: "stop" });
          expect(cancelled.alreadyFinished).toBe(false);
          const head = await snapshotStore.getLatest(run.id);
          assertNonNullable(head);
          expect(head.entry.executionStatus).toBe("FINISHED");

          if (state === "absent") {
            await dropAllSnapshotState(snapshotStore, redisOptions, run.id);
            await expectNoSnapshotAnywhere(prisma, snapshotStore, run.id);
          } else {
            await snapshotStore.dropRun(run.id);
            expect(await snapshotStore.getLatest(run.id)).toBeNull();
            expect(await snapshotStore.readBirthResidency(run.id)).toBe("redis-primary");
          }
          const row = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
          expect(row.status).toBe("CANCELED");

          await engine.runAttemptSystem.ensureRunFinalized({ runId: run.id });

          const worker = (engine as any).worker;
          expect(await worker.getJob(`ensureRunFinalized:${run.id}`)).toBeNull();
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );
  }

  containerTest(
    "enqueueDelayedRun on a CANCELED delayed run with no snapshot skips the enqueue",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const { engine, snapshotStore } = redisOnlyEngine(prisma, redisOptions);
      try {
        await setupBackgroundWorker(engine, env, taskIdentifier);
        const run = await triggerRun(engine, env, prisma, 7, new Date(Date.now() + 60_000));
        const cancelled = await engine.cancelRun({ runId: run.id, reason: "stop" });
        expect(cancelled.alreadyFinished).toBe(false);
        await dropAllSnapshotState(snapshotStore, redisOptions, run.id);
        await expectNoSnapshotAnywhere(prisma, snapshotStore, run.id);

        await engine.delayedRunSystem.enqueueDelayedRun({ runId: run.id });

        const after = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(after.status).toBe("CANCELED");
        expect(after.queuedAt).toBeNull();
        expect(await engine.runQueue.lengthOfEnvQueue(env)).toBe(0);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );
});
