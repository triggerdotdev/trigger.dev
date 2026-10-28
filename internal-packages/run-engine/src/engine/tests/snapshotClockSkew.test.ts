import { assertNonNullable, containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { RedisOptions } from "@internal/redis";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { describe, expect, vi } from "vitest";
import { RunEngine } from "../index.js";
import { PostgresPendingVersionRunIdLookup } from "./postgresPendingVersionLookup.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

// How far one engine's clock runs ahead of the engine handling the next transition.
const CLOCK_AHEAD_MS = 5_000;

type EngineOptions = ConstructorParameters<typeof RunEngine>[0];

function createEngine(
  prisma: PrismaClient,
  redisOptions: RedisOptions,
  overrides: Partial<EngineOptions> = {}
) {
  return new RunEngine({
    prisma,
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 50,
    },
    queue: {
      redis: redisOptions,
      retryOptions: { maxTimeoutInMs: 50 },
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
    ...overrides,
  });
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
      friendlyId: "run_skew1",
      environment,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t_skew1",
      spanId: "s_skew1",
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

async function startWithDequeueClockAhead(engine: RunEngine, prisma: PrismaClient) {
  const { run, environment } = await triggerRun(engine, prisma, ["test-task"]);
  const message = await withClockAhead(() => dequeueOne(engine));
  expect(message.snapshot.executionStatus).toBe("PENDING_EXECUTING");

  const attempt = await engine.startRunAttempt({
    runId: message.run.id,
    snapshotId: message.snapshot.id,
  });
  expect(attempt.snapshot.executionStatus).toBe("EXECUTING");
  expect(
    attempt.snapshot.friendlyId > message.snapshot.friendlyId,
    "a runner holding the dequeued snapshot would ignore the attempt's snapshot"
  ).toBe(true);

  return { run, environment, attempt };
}

async function expectSnapshotsInWriteOrder(prisma: PrismaClient, runId: string) {
  const snapshots = await prisma.taskRunExecutionSnapshot.findMany({
    where: { runId, isValid: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, executionStatus: true },
  });
  for (let i = 1; i < snapshots.length; i++) {
    const previous = snapshots[i - 1]!;
    const current = snapshots[i]!;
    expect(
      current.createdAt.getTime(),
      `${current.executionStatus} is not stamped after ${previous.executionStatus}`
    ).toBeGreaterThan(previous.createdAt.getTime());
    expect(
      current.id > previous.id,
      `${current.executionStatus} id sorts before ${previous.executionStatus} id`
    ).toBe(true);
  }
}

describe("RunEngine snapshot ordering across engine clocks", () => {
  containerTestWithIsolatedRedis(
    "an attempt started on an engine whose clock is behind the dequeuing engine still completes",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, attempt } = await startWithDequeueClockAhead(engine, prisma);

        const executing = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executing);
        expect(executing.snapshot.id).toBe(attempt.snapshot.id);

        const result = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          completion: {
            id: run.id,
            ok: true,
            output: '{"foo":"bar"}',
            outputType: "application/json",
          },
        });
        expect(result.attemptStatus).toBe("RUN_FINISHED");

        const finished = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(finished);
        expect(finished.snapshot.executionStatus).toBe("FINISHED");
        expect(finished.run.status).toBe("COMPLETED_SUCCESSFULLY");
        await expectSnapshotsInWriteOrder(prisma, run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "a run dequeued on an engine whose clock is behind the enqueuing engine still starts",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run } = await triggerRun(engine, prisma, ["test-task"]);
        await prisma.taskRunExecutionSnapshot.updateMany({
          where: { runId: run.id, executionStatus: "QUEUED" },
          data: { createdAt: new Date(Date.now() + CLOCK_AHEAD_MS) },
        });
        const message = await dequeueOne(engine);
        expect(message.snapshot.executionStatus).toBe("PENDING_EXECUTING");

        const dequeued = await engine.getRunExecutionData({ runId: run.id });
        expect(dequeued?.snapshot.id, "the queued snapshot still reads as latest").toBe(
          message.snapshot.id
        );

        const attempt = await engine.startRunAttempt({
          runId: message.run.id,
          snapshotId: message.snapshot.id,
        });
        expect(attempt.snapshot.executionStatus).toBe("EXECUTING");
        await expectSnapshotsInWriteOrder(prisma, run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "a wait in such an attempt blocks the executing run and resumes it",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, environment, attempt } = await startWithDequeueClockAhead(engine, prisma);

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
        while (latest?.snapshot.executionStatus !== "EXECUTING" && performance.now() < deadline) {
          await setTimeout(20);
          latest = await engine.getRunExecutionData({ runId: run.id });
        }
        assertNonNullable(latest);
        expect(latest.snapshot.executionStatus, "run never resumed after the wait").toBe(
          "EXECUTING"
        );
        expect(latest.snapshot.id).not.toBe(attempt.snapshot.id);

        const result = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: latest.snapshot.id,
          completion: {
            id: run.id,
            ok: true,
            output: '{"foo":"bar"}',
            outputType: "application/json",
          },
        });
        expect(result.attemptStatus).toBe("RUN_FINISHED");
        await expectSnapshotsInWriteOrder(prisma, run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "a failed attempt requeued for retry is dequeued again",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, attempt } = await startWithDequeueClockAhead(engine, prisma);

        const result = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          completion: {
            ok: false,
            id: run.id,
            error: {
              type: "BUILT_IN_ERROR",
              name: "UserError",
              message: "boom",
              stackTrace: "Error: boom\n    at <anonymous>:1:1",
            },
            retry: { timestamp: Date.now(), delay: 0 },
          },
          forceRequeue: true,
        });
        expect(result.attemptStatus).toBe("RETRY_QUEUED");

        const latest = await engine.getRunExecutionData({ runId: run.id });
        expect(latest?.snapshot.executionStatus).toBe("QUEUED");

        const redequeued = await dequeueOne(engine);
        expect(redequeued.snapshot.executionStatus).toBe("PENDING_EXECUTING");
        await expectSnapshotsInWriteOrder(prisma, run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "cancelling such an attempt reaches the runner",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, attempt } = await startWithDequeueClockAhead(engine, prisma);

        await engine.cancelRun({ runId: run.id, reason: "test" });

        const latest = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(latest);
        expect(latest.snapshot.executionStatus).toBe("PENDING_CANCEL");
        expect(
          latest.snapshot.friendlyId > attempt.snapshot.friendlyId,
          "a runner holding the attempt's snapshot would ignore the cancellation"
        ).toBe(true);
        await expectSnapshotsInWriteOrder(prisma, run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "releasing a run dequeued on an engine whose clock is ahead requeues it after that snapshot",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run } = await triggerRun(engine, prisma, ["test-task"]);
        const message = await withClockAhead(() => dequeueOne(engine));

        const released = await engine.releaseRun({
          runId: run.id,
          snapshotId: message.snapshot.id,
          reason: "PodFailed",
        });
        expect(released).toEqual({ ok: true, requeued: true });

        const latest = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(latest);
        expect(latest.snapshot.executionStatus).toBe("QUEUED");
        await expectSnapshotsInWriteOrder(prisma, run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "a run parked for a missing version on an engine whose clock is ahead is promoted",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions, {
        pendingVersionRunIdLookup: new PostgresPendingVersionRunIdLookup(prisma),
      });

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
        await expectSnapshotsInWriteOrder(prisma, run.id);
      } finally {
        await engine.quit();
      }
    }
  );
});
