import { assertNonNullable, containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { RedisOptions } from "@internal/redis";
import {
  PostgresRunStore,
  RedisSnapshotStore,
  SnapshotResidencyResolver,
  TaskRunExecutionSnapshotStore,
  type TaskRunExecutionSnapshotStoreMode,
} from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { describe, expect, vi } from "vitest";
import { RunEngine } from "../index.js";
import { createCompletedWaitpointResolver } from "../systems/completedWaitpointResolver.js";
import { PostgresPendingVersionRunIdLookup } from "./postgresPendingVersionLookup.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

// The dequeuing engine's clock runs this far ahead of the engine handling the next transition.
const CLOCK_AHEAD_MS = 5_000;
const MODES: TaskRunExecutionSnapshotStoreMode[] = ["dual-write", "redis-read", "redis-only"];

function createEngine(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  mode: TaskRunExecutionSnapshotStoreMode,
  withPendingVersion = false
) {
  const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
  const delegate = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const store = new TaskRunExecutionSnapshotStore(delegate, {
    store: snapshotStore,
    mode,
    resolveDial: () => mode,
    residencyResolver: new SnapshotResidencyResolver({ store: snapshotStore }),
    resolveCompletedWaitpoints: createCompletedWaitpointResolver(delegate),
    logicalRunStoreRoute: "logical:1",
  });
  const engine = new RunEngine({
    prisma,
    store,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 50 },
    queue: {
      redis: redisOptions,
      retryOptions: { maxTimeoutInMs: 50 },
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
    ...(withPendingVersion && {
      pendingVersionRunIdLookup: new PostgresPendingVersionRunIdLookup(prisma),
    }),
  });
  return { engine, snapshotStore };
}

async function withClockAhead<T>(fn: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(Date.now() + CLOCK_AHEAD_MS);
  try {
    return await fn();
  } finally {
    vi.useRealTimers();
  }
}

async function triggerRun(engine: RunEngine, prisma: PrismaClient, workerTasks: string[]) {
  const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  await setupBackgroundWorker(engine, environment, workerTasks, undefined, { maxAttempts: 3 });
  const run = await engine.trigger(
    {
      number: 1,
      friendlyId: "run_skewstore1",
      environment,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t_skewstore1",
      spanId: "s_skewstore1",
      workerQueue: "main",
      queue: "task/test-task",
      isTest: false,
      tags: [],
    },
    prisma
  );
  return { run, environment };
}

async function dequeueOne(engine: RunEngine) {
  const deadline = performance.now() + 10_000;
  let dequeued = await engine.dequeueFromWorkerQueue({
    consumerId: "test_skew",
    workerQueue: "main",
    blockingPopTimeoutSeconds: 1,
  });
  while (dequeued.length === 0 && performance.now() < deadline) {
    await setTimeout(20);
    dequeued = await engine.dequeueFromWorkerQueue({
      consumerId: "test_skew",
      workerQueue: "main",
      blockingPopTimeoutSeconds: 1,
    });
  }
  expect(dequeued.length, "run was never dequeued").toBe(1);
  const message = dequeued[0];
  assertNonNullable(message);
  return message;
}

async function expectWriteOrder(
  mode: TaskRunExecutionSnapshotStoreMode,
  prisma: PrismaClient,
  snapshotStore: RedisSnapshotStore,
  runId: string
) {
  let snapshots: { id: string; createdAt: number; status: string }[];
  if (mode === "redis-only") {
    const since = await snapshotStore.getSinceCreatedAt(runId, new Date(0), { limit: 100 });
    expect(since.kind).toBe("hit");
    if (since.kind !== "hit") return;
    snapshots = since.entries
      .filter((e) => e.isValid)
      .sort((a, b) => a.seq - b.seq)
      .map((e) => ({
        id: e.id,
        createdAt: new Date(e.entry.createdAt as string).getTime(),
        status: String(e.entry.executionStatus),
      }));
    expect(
      await prisma.taskRunExecutionSnapshot.count({ where: { runId } }),
      "redis-only run wrote Postgres rows"
    ).toBe(0);
  } else {
    snapshots = (
      await prisma.taskRunExecutionSnapshot.findMany({
        where: { runId, isValid: true },
        orderBy: { createdAt: "asc" },
        select: { id: true, createdAt: true, executionStatus: true },
      })
    ).map((s) => ({ id: s.id, createdAt: s.createdAt.getTime(), status: s.executionStatus }));
  }
  expect(snapshots.length).toBeGreaterThan(2);
  for (let i = 1; i < snapshots.length; i++) {
    const previous = snapshots[i - 1]!;
    const current = snapshots[i]!;
    expect(current.createdAt, `${current.status} not after ${previous.status}`).toBeGreaterThan(
      previous.createdAt
    );
    expect(current.id > previous.id, `${current.status} id before ${previous.status}`).toBe(true);
  }
}

describe.each(MODES)(
  "RunEngine snapshot ordering across engine clocks, %s snapshot store",
  (mode) => {
    containerTestWithIsolatedRedis(
      "start, poll since the dequeued snapshot, complete",
      async ({ prisma, redisOptions }) => {
        const { engine, snapshotStore } = createEngine(prisma, redisOptions, mode);
        try {
          const { run } = await triggerRun(engine, prisma, ["test-task"]);
          const message = await withClockAhead(() => dequeueOne(engine));
          const attempt = await engine.startRunAttempt({
            runId: message.run.id,
            snapshotId: message.snapshot.id,
          });
          expect(attempt.snapshot.friendlyId > message.snapshot.friendlyId).toBe(true);

          const since = await engine.getSnapshotsSince({
            runId: run.id,
            snapshotId: message.snapshot.id,
          });
          expect(
            since?.map((s) => s.snapshot.id),
            "runner poll since the dequeued snapshot misses the attempt's snapshot"
          ).toContain(attempt.snapshot.id);

          const latest = await engine.getRunExecutionData({ runId: run.id });
          expect(latest?.snapshot.id).toBe(attempt.snapshot.id);

          const result = await engine.completeRunAttempt({
            runId: run.id,
            snapshotId: attempt.snapshot.id,
            completion: { id: run.id, ok: true, output: "{}", outputType: "application/json" },
          });
          expect(result.attemptStatus).toBe("RUN_FINISHED");
          await expectWriteOrder(mode, prisma, snapshotStore, run.id);
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );

    containerTestWithIsolatedRedis(
      "wait and resume, then cancel",
      async ({ prisma, redisOptions }) => {
        const { engine, snapshotStore } = createEngine(prisma, redisOptions, mode);
        try {
          const { run, environment } = await triggerRun(engine, prisma, ["test-task"]);
          const message = await withClockAhead(() => dequeueOne(engine));
          const attempt = await engine.startRunAttempt({
            runId: message.run.id,
            snapshotId: message.snapshot.id,
          });

          const { waitpoint } = await engine.createManualWaitpoint({
            runId: run.id,
            environmentId: environment.id,
            projectId: environment.projectId,
          });
          const blocked = await engine.blockRunWithWaitpoint({
            runId: run.id,
            waitpoints: waitpoint.id,
            projectId: environment.projectId,
            organizationId: environment.organizationId,
          });
          expect(blocked.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
          await engine.completeWaitpoint({ id: waitpoint.id });

          const deadline = performance.now() + 10_000;
          let latest = await engine.getRunExecutionData({ runId: run.id });
          while (
            (latest?.snapshot.executionStatus !== "EXECUTING" ||
              latest.snapshot.id === attempt.snapshot.id) &&
            performance.now() < deadline
          ) {
            await setTimeout(20);
            latest = await engine.getRunExecutionData({ runId: run.id });
          }
          assertNonNullable(latest);
          expect(latest.snapshot.executionStatus, "run never resumed").toBe("EXECUTING");
          expect(latest.snapshot.id).not.toBe(attempt.snapshot.id);

          await engine.cancelRun({ runId: run.id, reason: "test" });
          const cancelled = await engine.getRunExecutionData({ runId: run.id });
          assertNonNullable(cancelled);
          expect(cancelled.snapshot.executionStatus).toBe("PENDING_CANCEL");
          expect(cancelled.snapshot.friendlyId > latest.snapshot.friendlyId).toBe(true);
          await expectWriteOrder(mode, prisma, snapshotStore, run.id);
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );

    containerTestWithIsolatedRedis(
      "failed attempt requeued for retry is dequeued again",
      async ({ prisma, redisOptions }) => {
        const { engine, snapshotStore } = createEngine(prisma, redisOptions, mode);
        try {
          const { run } = await triggerRun(engine, prisma, ["test-task"]);
          const message = await withClockAhead(() => dequeueOne(engine));
          const attempt = await engine.startRunAttempt({
            runId: message.run.id,
            snapshotId: message.snapshot.id,
          });
          const result = await engine.completeRunAttempt({
            runId: run.id,
            snapshotId: attempt.snapshot.id,
            completion: {
              ok: false,
              id: run.id,
              error: { type: "BUILT_IN_ERROR", name: "UserError", message: "boom", stackTrace: "" },
              retry: { timestamp: Date.now(), delay: 0 },
            },
            forceRequeue: true,
          });
          expect(result.attemptStatus).toBe("RETRY_QUEUED");
          const redequeued = await dequeueOne(engine);
          expect(redequeued.snapshot.executionStatus).toBe("PENDING_EXECUTING");
          await expectWriteOrder(mode, prisma, snapshotStore, run.id);
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );

    containerTestWithIsolatedRedis(
      "pending-version park on a clock-ahead engine, then promote",
      async ({ prisma, redisOptions }) => {
        const { engine, snapshotStore } = createEngine(prisma, redisOptions, mode, true);
        try {
          const { run, environment } = await triggerRun(engine, prisma, ["test-task-other"]);
          await withClockAhead(async () => {
            const deadline = performance.now() + 10_000;
            let parked = await engine.getRunExecutionData({ runId: run.id });
            while (parked?.run.status !== "PENDING_VERSION" && performance.now() < deadline) {
              await engine.dequeueFromWorkerQueue({
                consumerId: "test_skew",
                workerQueue: "main",
                blockingPopTimeoutSeconds: 1,
              });
              parked = await engine.getRunExecutionData({ runId: run.id });
            }
            expect(parked?.run.status, "run was never parked").toBe("PENDING_VERSION");
          });
          await setupBackgroundWorker(engine, environment, "test-task", undefined, {
            maxAttempts: 3,
          });
          const deadline = performance.now() + 10_000;
          let latest = await engine.getRunExecutionData({ runId: run.id });
          while (latest?.snapshot.executionStatus !== "QUEUED" && performance.now() < deadline) {
            await setTimeout(50);
            latest = await engine.getRunExecutionData({ runId: run.id });
          }
          expect(latest?.snapshot.executionStatus, "parked run was never promoted").toBe("QUEUED");
          const dequeued = await dequeueOne(engine);
          expect(dequeued.snapshot.executionStatus).toBe("PENDING_EXECUTING");
          await expectWriteOrder(mode, prisma, snapshotStore, run.id);
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );
  }
);
