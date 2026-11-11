import { type RedisOptions } from "@internal/redis";
import { hasStoreWaitpoints, PostgresRunStore } from "@internal/run-store";
import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import {
  generateRunOpsId,
  generateWaitpointId,
  SnapshotId,
  WaitpointId,
} from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { RunEngine } from "../index.js";
import {
  cycleAnchorSnapshotId,
  WaitpointSystem,
  type WaitpointSystemOptions,
} from "../systems/waitpointSystem.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { StoreWaitpointCoordinator } from "../waitpointCoordinator/storeWaitpointCoordinator.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

type Env = Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function boundedBarrier(promise: Promise<void>, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function enabledEngine(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  store: WaitpointStoreCoordinator,
  maxTotalWaitTime?: number
) {
  const engine = new RunEngine({
    prisma,
    store: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: {
      redis: redisOptions,
      ...(maxTotalWaitTime ? { retryConfig: { maxTotalWaitTime } } : {}),
    },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("legacy-child-admission", "test"),
    waitpointStoreEnabled: () => true,
    waitpointStore: store,
  });
  // #852 wires this supported adapter. Use the engine's real resources at this foundation.
  const existing = engine.waitpointSystem as unknown as { options: WaitpointSystemOptions };
  engine.waitpointSystem = new WaitpointSystem({
    ...existing.options,
    waitpointRouting: {
      store: new StoreWaitpointCoordinator({ store }),
      // Mint children legacy so triggerAndWait stays on the legacy admission path under test.
      mintPolicy: { resolveMintMode: () => "legacy", isCapabilityReady: () => true },
    },
  });
  return engine;
}

async function executingParent(engine: RunEngine, env: Env, prisma: PrismaClient, id: string) {
  const run = await engine.trigger(
    {
      number: 1,
      friendlyId: id,
      environment: env,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t_${id}`,
      spanId: `s_${id}`,
      workerQueue: "main",
      queue: "task/test-task",
      isTest: false,
      tags: [],
    },
    prisma
  );
  const dequeued = await vi.waitFor(
    async () => {
      const d = await engine.dequeueFromWorkerQueue({
        consumerId: `c_${id}`,
        workerQueue: "main",
        blockingPopTimeoutSeconds: 1,
      });
      expect(d.length, "parent never reached the worker queue").toBe(1);
      return d;
    },
    { timeout: 10_000, interval: 100 }
  );
  const attempt = await engine.startRunAttempt({
    runId: dequeued[0]!.run.id,
    snapshotId: dequeued[0]!.snapshot.id,
  });
  expect(attempt.snapshot.executionStatus).toBe("EXECUTING");
  return run;
}

function triggerChild(
  engine: RunEngine,
  env: Env,
  prisma: PrismaClient,
  args: { parentId?: string; batchId?: string; friendlyId: string; key: string }
) {
  return engine.trigger(
    {
      number: 1,
      friendlyId: args.friendlyId,
      environment: env,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t_${args.key}`,
      spanId: `s_${args.key}`,
      workerQueue: "main",
      queue: "task/test-task",
      isTest: false,
      tags: [],
      parentTaskRunId: args.parentId,
      resumeParentOnCompletion: args.parentId !== undefined,
      idempotencyKey: args.key,
      batch: args.batchId ? { id: args.batchId, index: 0 } : undefined,
    },
    prisma
  );
}

/** Block an executing parent on a native store waitpoint as block B1, which marks the parent. */
async function blockOnStore(
  engine: RunEngine,
  store: WaitpointStoreCoordinator,
  env: Env,
  runId: string
) {
  const source = generateWaitpointId("MANUAL");
  const now = new Date().toISOString();
  await store.createIfAbsent({
    record: {
      id: source,
      friendlyId: WaitpointId.toFriendlyId(source),
      type: "MANUAL",
      environmentId: env.id,
      organizationId: env.organization.id,
      projectId: env.project.id,
      createdAt: now,
      updatedAt: now,
      userProvidedIdempotencyKey: false,
      tags: [],
    },
    status: "PENDING",
  });
  const latest = await engine.runStore.findLatestExecutionSnapshot(runId);
  await engine.blockRunWithWaitpoint({
    runId,
    projectId: env.project.id,
    organizationId: env.organization.id,
    waitpoints: [source],
    blockOperation: { id: "B1", absorptionId: "B1", cycleAnchor: cycleAnchorSnapshotId(latest!) },
  });
}

function armFence(engine: RunEngine, env: Env, runId: string) {
  return engine.waitpointSystem.prepareFailedAttemptCleanup({
    runId,
    organizationId: env.organization.id,
    transitionId: SnapshotId.generate().id,
  });
}

/** The child run committed for this friendly id must be terminal, keyless, settled and unqueued. */
async function expectRetired(
  engine: RunEngine,
  prisma: PrismaClient,
  env: Env,
  friendlyId: string
) {
  const child = await prisma.taskRun.findFirstOrThrow({ where: { friendlyId } });
  expect(child.status).toBe("SYSTEM_FAILURE");
  expect(child.idempotencyKey).toBeNull();
  const waitpoint = await prisma.waitpoint.findFirstOrThrow({
    where: { completedByTaskRunId: child.id },
  });
  expect(waitpoint.status).toBe("COMPLETED");
  expect(await engine.runQueue.messageExists(env.organization.id, child.id)).toBeFalsy();
  return child;
}

describe("Enabled legacy child admission", () => {
  // Catches: the parent run lock held across child createRun, serialising admissions with parent lifecycle ops.
  containerTestWithIsolatedRedis(
    "ADMISSION: a held parent run lock does not delay legacy child creation; only the edge write waits",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const engine = enabledEngine(prisma, redisOptions, store);
      const locked = deferred();
      const release = deferred();
      let held: Promise<void> | undefined;
      let producer: Promise<unknown> | undefined;
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await executingParent(engine, env, prisma, "run_heldparent");
        expect(
          hasStoreWaitpoints(
            (await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } })).annotations
          )
        ).toBe(false);

        held = engine["runLock"].lock("parentOp", [run.id], async () => {
          locked.resolve();
          await boundedBarrier(release.promise, "test never released the parent run lock");
        });
        await boundedBarrier(locked.promise, "parent operation never acquired the run lock");

        const batch = await prisma.batchTaskRun.create({
          data: {
            id: "held_parent_batch",
            friendlyId: "batch_held_parent",
            runtimeEnvironmentId: env.id,
          },
        });
        const friendlyId = `run_${generateRunOpsId()}`;
        let settled = false;
        producer = triggerChild(engine, env, prisma, {
          parentId: run.id,
          batchId: batch.id,
          friendlyId,
          key: "held_parent_child",
        }).finally(() => {
          settled = true;
        });

        await vi.waitFor(
          async () => {
            expect(
              await prisma.taskRun.count({ where: { friendlyId } }),
              "child row was not committed while the parent run lock was held"
            ).toBe(1);
          },
          { timeout: 3_000, interval: 25 }
        );
        // The child committed while the parent lock was still held; its edge write is waiting on it.
        expect(settled).toBe(false);
        expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(0);

        release.resolve();
        await held;
        await producer;
        expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(1);
      } finally {
        release.resolve();
        await held;
        await producer?.catch(() => undefined);
        await engine.quit();
        await store.quit();
      }
    }
  );

  // Catches: a dropped pre-createRun fence check committing a child row/key for a parent owing cleanup.
  containerTestWithIsolatedRedis(
    "ADMISSION: a fence armed before trigger refuses the legacy child before its row is committed",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const engine = enabledEngine(prisma, redisOptions, store);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await executingParent(engine, env, prisma, "run_fencedparent");
        await blockOnStore(engine, store, env, run.id);
        await engine["runLock"].lock("attemptFailed", [run.id], () =>
          armFence(engine, env, run.id)
        );

        const batch = await prisma.batchTaskRun.create({
          data: {
            id: "fenced_parent_batch",
            friendlyId: "batch_fenced_parent",
            runtimeEnvironmentId: env.id,
          },
        });
        const childId = generateRunOpsId();
        const friendlyId = `run_${childId}`;
        await expect(
          triggerChild(engine, env, prisma, {
            parentId: run.id,
            batchId: batch.id,
            friendlyId,
            key: "fenced_parent_child",
          })
        ).rejects.toMatchObject({ outcome: "cleanupOwed", currentBlockId: "B1" });
        expect(await prisma.taskRun.count({ where: { friendlyId } })).toBe(0);
        expect(await engine.runQueue.messageExists(env.organization.id, childId)).toBeFalsy();
      } finally {
        await engine.quit();
        await store.quit();
      }
    }
  );
  // Catches: a child committed before a race-armed fence left PENDING and keyed, trapping a keyed re-trigger.
  containerTestWithIsolatedRedis(
    "ADMISSION RACE: a child refused by a fence armed after its commit is failed and releases its key",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const engine = enabledEngine(prisma, redisOptions, store);
      const locked = deferred();
      const arm = deferred();
      let held: Promise<unknown> | undefined;
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await executingParent(engine, env, prisma, "run_raceparent");
        await blockOnStore(engine, store, env, run.id);
        const pendingIds = (await store.readBlockState(run.id)).pendingIds;
        const friendlyId = `run_${generateRunOpsId()}`;
        const key = "race_key";

        // Hold the parent lock; arm the fence under it only once the child has committed.
        held = engine["runLock"].lock("attemptFailed", [run.id], async () => {
          locked.resolve();
          await boundedBarrier(arm.promise, "test never armed the cleanup fence");
          await armFence(engine, env, run.id);
        });
        await boundedBarrier(locked.promise, "attempt failure never acquired the run lock");
        const producer = triggerChild(engine, env, prisma, {
          parentId: run.id,
          friendlyId,
          key,
        }).then(
          () => undefined,
          (error: unknown) => error
        );
        await vi.waitFor(
          async () =>
            expect(
              await prisma.taskRun.count({ where: { friendlyId } }),
              "child never committed before its edge write"
            ).toBe(1),
          { timeout: 3_000, interval: 25 }
        );
        arm.resolve();
        await held;

        expect(await producer).toMatchObject({ outcome: "cleanupOwed", currentBlockId: "B1" });
        const child = await expectRetired(engine, prisma, env, friendlyId);
        expect((await store.readBlockState(run.id)).pendingIds).toEqual(pendingIds);
        expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(0);

        const retriggered = await triggerChild(engine, env, prisma, {
          friendlyId: `run_${generateRunOpsId()}`,
          key,
        });
        expect(retriggered.id).not.toBe(child.id);
      } finally {
        arm.resolve();
        await held?.catch(() => undefined);
        await engine.quit();
        await store.quit();
      }
    }
  );

  // Catches: a child whose edge write timed out on the parent lock left PENDING, keyed and never enqueued.
  containerTestWithIsolatedRedis(
    "ADMISSION RACE: a child whose edge write times out on the parent lock is failed and releases its key",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const engine = enabledEngine(prisma, redisOptions, store, 1_000);
      const locked = deferred();
      const release = deferred();
      let held: Promise<unknown> | undefined;
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await executingParent(engine, env, prisma, "run_timeoutparent");
        const batch = await prisma.batchTaskRun.create({
          data: { id: "timeout_batch", friendlyId: "batch_timeout", runtimeEnvironmentId: env.id },
        });
        const friendlyId = `run_${generateRunOpsId()}`;

        held = engine["runLock"].lock("parentOp", [run.id], async () => {
          locked.resolve();
          await boundedBarrier(release.promise, "test never released the parent run lock");
        });
        await boundedBarrier(locked.promise, "parent operation never acquired the run lock");
        const refusal = await triggerChild(engine, env, prisma, {
          parentId: run.id,
          batchId: batch.id,
          friendlyId,
          key: "timeout_key",
        }).then(
          () => undefined,
          (error: unknown) => error
        );
        release.resolve();
        await held;

        expect(refusal).toMatchObject({ name: "LockAcquisitionTimeoutError" });
        await expectRetired(engine, prisma, env, friendlyId);
        expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(0);
      } finally {
        release.resolve();
        await held?.catch(() => undefined);
        await engine.quit();
        await store.quit();
      }
    }
  );

  // Catches: the batch header admitted without the parent lock, committing a BATCH waitpoint with no edge.
  containerTestWithIsolatedRedis(
    "ADMISSION: a batch header that cannot take the parent lock creates no waitpoint",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const engine = enabledEngine(prisma, redisOptions, store, 1_000);
      const locked = deferred();
      const release = deferred();
      let held: Promise<unknown> | undefined;
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        await setupBackgroundWorker(engine, env, "test-task");
        const run = await executingParent(engine, env, prisma, "run_headertimeout");
        const batch = await prisma.batchTaskRun.create({
          data: {
            id: "header_timeout_batch",
            friendlyId: "batch_header_timeout",
            runtimeEnvironmentId: env.id,
          },
        });

        held = engine["runLock"].lock("parentOp", [run.id], async () => {
          locked.resolve();
          await boundedBarrier(release.promise, "test never released the parent run lock");
        });
        await boundedBarrier(locked.promise, "parent operation never acquired the run lock");
        const refusal = await engine
          .blockRunWithCreatedBatch({
            runId: run.id,
            batchId: batch.id,
            environmentId: env.id,
            projectId: env.project.id,
            organizationId: env.organization.id,
          })
          .then(
            () => undefined,
            (error: unknown) => error
          );
        release.resolve();
        await held;

        expect(refusal).toMatchObject({ name: "LockAcquisitionTimeoutError" });
        expect(
          await prisma.waitpoint.count({ where: { completedByBatchId: batch.id } }),
          "BATCH waitpoint committed without the parent lock"
        ).toBe(0);
      } finally {
        release.resolve();
        await held?.catch(() => undefined);
        await engine.quit();
        await store.quit();
      }
    }
  );
});
