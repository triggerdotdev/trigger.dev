import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { RetryOptions } from "@trigger.dev/core/v3";
import type { Meter } from "@internal/tracing";
import { Prisma, type PrismaClient } from "@trigger.dev/database";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "node:timers/promises";
import { createTestMetricsMeter } from "./helpers/replicaTestHelpers.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function createEngine(
  prisma: PrismaClient,
  redisOptions: any,
  queueMaxAttempts?: number,
  meter?: Meter
) {
  return new RunEngine({
    prisma,
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
      // A short queue backoff, so a requeued restore is redelivered within dequeue's wait.
      retryOptions: {
        ...(queueMaxAttempts ? { maxAttempts: queueMaxAttempts } : {}),
        minTimeoutInMs: 10,
        maxTimeoutInMs: 50,
      },
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
      baseCostInCents: 0.0005,
    },
    tracer: trace.getTracer("test", "0.0.0"),
    meter,
  });
}

async function dequeue(
  engine: RunEngine,
  environmentId: string,
  workerQueue = "main",
  workerId?: string
) {
  await setTimeout(500);
  await engine.runQueue.processMasterQueueForEnvironment(environmentId);
  return engine.dequeueFromWorkerQueue({
    consumerId: "test_12345",
    workerQueue,
    workerId,
  });
}

// Runs a task up to a checkpoint and dequeues it for a restore, leaving the PENDING_EXECUTING
// snapshot a restore dequeue creates.
async function dequeueForRestore(
  engine: RunEngine,
  prisma: PrismaClient,
  retryOptions?: RetryOptions,
  lanes: {
    workerQueue: string;
    restoreWorkerQueue: string;
    checkpointType: "DOCKER" | "COMPUTE";
  } = {
    workerQueue: "main",
    restoreWorkerQueue: "main",
    checkpointType: "DOCKER",
  }
) {
  const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  const taskIdentifier = "test-task";

  await setupBackgroundWorker(
    engine,
    authenticatedEnvironment,
    taskIdentifier,
    undefined,
    retryOptions
  );

  const run = await engine.trigger(
    {
      number: 1,
      friendlyId: "run_1234",
      environment: authenticatedEnvironment,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      workerQueue: lanes.workerQueue,
      queue: "task/test-task",
      isTest: false,
      tags: [],
    },
    prisma
  );

  const firstDequeue = await dequeue(engine, authenticatedEnvironment.id, lanes.workerQueue);
  expect(firstDequeue.length).toBe(1);
  assertNonNullable(firstDequeue[0]);

  await engine.startRunAttempt({
    runId: firstDequeue[0].run.id,
    snapshotId: firstDequeue[0].snapshot.id,
  });

  const waitpointResult = await engine.createManualWaitpoint({
    environmentId: authenticatedEnvironment.id,
    projectId: authenticatedEnvironment.projectId,
  });

  const blockedResult = await engine.blockRunWithWaitpoint({
    runId: run.id,
    waitpoints: waitpointResult.waitpoint.id,
    projectId: authenticatedEnvironment.projectId,
    organizationId: authenticatedEnvironment.organizationId,
  });

  const checkpointResult = await engine.createCheckpoint({
    runId: run.id,
    snapshotId: blockedResult.id,
    checkpoint: {
      type: lanes.checkpointType,
      reason: "TEST_CHECKPOINT",
      location: "test-location",
      imageRef: "test-image-ref",
    },
  });
  expect(checkpointResult.ok).toBe(true);

  await engine.completeWaitpoint({ id: waitpointResult.waitpoint.id });

  const restoreDequeue = await dequeue(
    engine,
    authenticatedEnvironment.id,
    lanes.restoreWorkerQueue
  );
  expect(restoreDequeue.length).toBe(1);
  assertNonNullable(restoreDequeue[0]);
  expect(restoreDequeue[0].snapshot.executionStatus).toBe("PENDING_EXECUTING");
  assertNonNullable(restoreDequeue[0].checkpoint);

  return {
    authenticatedEnvironment,
    run,
    staleSnapshotId: firstDequeue[0].snapshot.id,
    restore: restoreDequeue[0],
  };
}

describe("RunEngine reportRestoreOutcome", () => {
  containerTest(
    "requeue gives the run back with the same checkpoint",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { authenticatedEnvironment, run, restore } = await dequeueForRestore(engine, prisma);

        const result = await engine.reportRestoreOutcome({
          runId: run.id,
          snapshotId: restore.snapshot.id,
          outcome: "requeue",
          reason: "PodStartTimeout",
        });
        expect(result).toEqual({ ok: true, outcome: "requeue" });

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("QUEUED");
        expect(executionData.checkpoint?.id).toBe(restore.checkpoint?.id);

        const redelivered = await dequeue(engine, authenticatedEnvironment.id);
        expect(redelivered.length).toBe(1);
        assertNonNullable(redelivered[0]);
        expect(redelivered[0].snapshot.executionStatus).toBe("PENDING_EXECUTING");
        expect(redelivered[0].checkpoint?.id).toBe(restore.checkpoint?.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "fail fails the attempt as a crash and retries from scratch after the task's retry delay",
    async ({ prisma, redisOptions }) => {
      const { meter, getCounterValue } = createTestMetricsMeter();
      const engine = createEngine(prisma, redisOptions, undefined, meter);
      const retryDelayMs = 3_000;

      try {
        const { authenticatedEnvironment, run, restore } = await dequeueForRestore(engine, prisma, {
          maxAttempts: 3,
          factor: 1,
          minTimeoutInMs: retryDelayMs,
          maxTimeoutInMs: retryDelayMs,
          randomize: false,
        });

        const retries: { error: unknown; retryAt: Date }[] = [];
        engine.eventBus.on("runRetryScheduled", (event) => {
          retries.push({ error: event.run.error, retryAt: event.retryAt });
        });

        const failedAt = Date.now();
        const result = await engine.reportRestoreOutcome({
          runId: run.id,
          snapshotId: restore.snapshot.id,
          outcome: "fail",
          reason: "SnapshotNotFound",
          message: "snapshot is gone",
        });
        expect(result).toEqual({ ok: true, outcome: "fail" });

        expect(retries).toHaveLength(1);
        expect(retries[0]?.error).toEqual({
          type: "INTERNAL_ERROR",
          code: "TASK_RUN_CRASHED",
          message: "The run could not be restored: SnapshotNotFound",
        });
        const delayMs = (retries[0]?.retryAt.getTime() ?? 0) - failedAt;
        expect(delayMs).toBeGreaterThanOrEqual(retryDelayMs - 100);
        expect(delayMs).toBeLessThan(retryDelayMs + 1_000);

        expect(
          await getCounterValue("run_engine.restore_outcomes", {
            outcome: "fail",
            reason: "SnapshotNotFound",
            result: "applied",
          })
        ).toBe(1);

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("QUEUED");
        expect(executionData.checkpoint).toBeUndefined();

        await setTimeout(retryDelayMs);
        const retried = await dequeue(engine, authenticatedEnvironment.id);
        expect(retried.length).toBe(1);
        assertNonNullable(retried[0]);
        expect(retried[0].checkpoint).toBeUndefined();

        const attempt = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: retried[0].snapshot.id,
        });
        expect(attempt.run.attemptNumber).toBe(2);
      } finally {
        await engine.quit();
      }
    }
  );

  // The operator's message names the snapshot's recorded owner, which must not reach the run.
  containerTest(
    "fail for a refused snapshot keeps the operator's message out of the run's error",
    async ({ prisma, redisOptions }) => {
      const { meter, getCounterValue } = createTestMetricsMeter();
      const engine = createEngine(prisma, redisOptions, undefined, meter);
      const ownerMessage = "snapshot is owned by env_someone_else, not env_this_one";

      try {
        const { run, restore } = await dequeueForRestore(engine, prisma, {
          maxAttempts: 3,
          factor: 1,
          minTimeoutInMs: 1_000,
          maxTimeoutInMs: 1_000,
          randomize: false,
        });

        const retries: unknown[] = [];
        engine.eventBus.on("runRetryScheduled", (event) => retries.push(event.run.error));

        const result = await engine.reportRestoreOutcome({
          runId: run.id,
          snapshotId: restore.snapshot.id,
          outcome: "fail",
          reason: "SnapshotRefused",
          message: ownerMessage,
        });
        expect(result).toEqual({ ok: true, outcome: "fail" });

        expect(retries).toEqual([
          {
            type: "INTERNAL_ERROR",
            code: "TASK_RUN_CRASHED",
            message: "The run could not be restored: SnapshotRefused",
          },
        ]);
        const stored = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(JSON.stringify(stored.error ?? null)).not.toContain("env_someone_else");
        expect(
          await getCounterValue("run_engine.restore_outcomes", {
            outcome: "fail",
            reason: "SnapshotRefused",
            result: "applied",
          })
        ).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "fail after requeues near the queue limit retries the run and resets the queue attempts",
    async ({ prisma, redisOptions }) => {
      const queueMaxAttempts = 3;
      const engine = createEngine(prisma, redisOptions, queueMaxAttempts);

      try {
        const { authenticatedEnvironment, run, restore } = await dequeueForRestore(engine, prisma);
        const orgId = authenticatedEnvironment.organizationId;

        const retryErrors: unknown[] = [];
        engine.eventBus.on("runRetryScheduled", (event) => {
          retryErrors.push(event.run.error);
        });

        let snapshotId = restore.snapshot.id;
        for (let i = 0; i < queueMaxAttempts - 1; i++) {
          const requeued = await engine.reportRestoreOutcome({
            runId: run.id,
            snapshotId,
            outcome: "requeue",
            reason: "PodStartTimeout",
          });
          expect(requeued).toEqual({ ok: true, outcome: "requeue" });

          const redelivered = await dequeue(engine, authenticatedEnvironment.id);
          expect(redelivered.length).toBe(1);
          assertNonNullable(redelivered[0]);
          snapshotId = redelivered[0].snapshot.id;
        }

        const beforeFail = await engine.runQueue.readMessage(orgId, run.id);
        expect(beforeFail?.attempt).toBe(queueMaxAttempts - 1);

        const result = await engine.reportRestoreOutcome({
          runId: run.id,
          snapshotId,
          outcome: "fail",
          reason: "SnapshotNodeGone",
          message: "node is gone",
        });
        expect(result).toEqual({ ok: true, outcome: "fail" });

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("QUEUED");
        expect(executionData.run.status).not.toBe("SYSTEM_FAILURE");
        expect(retryErrors).toEqual([
          {
            type: "INTERNAL_ERROR",
            code: "TASK_RUN_CRASHED",
            message: "The run could not be restored: SnapshotNodeGone",
          },
        ]);

        const afterFail = await engine.runQueue.readMessage(orgId, run.id);
        expect(afterFail?.attempt).toBe(0);

        const retried = await dequeue(engine, authenticatedEnvironment.id);
        expect(retried.length).toBe(1);
        assertNonNullable(retried[0]);
        expect(retried[0].checkpoint).toBeUndefined();
      } finally {
        await engine.quit();
      }
    }
  );

  for (const kase of [
    { name: "no retries left", retryOptions: { maxAttempts: 1 }, clearLockedRetryConfig: false },
    { name: "no locked retry config", retryOptions: undefined, clearLockedRetryConfig: true },
  ]) {
    containerTest(`fail with ${kase.name} crashes the run`, async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, restore } = await dequeueForRestore(engine, prisma, kase.retryOptions);

        if (kase.clearLockedRetryConfig) {
          await prisma.taskRun.update({
            where: { id: run.id },
            data: { lockedRetryConfig: Prisma.DbNull },
          });
        }

        const retries: unknown[] = [];
        engine.eventBus.on("runRetryScheduled", (event) => {
          retries.push(event);
        });

        const result = await engine.reportRestoreOutcome({
          runId: run.id,
          snapshotId: restore.snapshot.id,
          outcome: "fail",
          reason: "SnapshotNodeGone",
          message: "node is gone",
        });
        expect(result).toEqual({ ok: true, outcome: "fail" });
        expect(retries).toHaveLength(0);

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("FINISHED");
        expect(executionData.run.status).toBe("CRASHED");

        const failedRun = await prisma.taskRun.findFirst({ where: { id: run.id } });
        assertNonNullable(failedRun);
        expect(failedRun.error).toEqual({
          type: "INTERNAL_ERROR",
          code: "TASK_RUN_CRASHED",
          message: "The run could not be restored: SnapshotNodeGone",
        });
      } finally {
        await engine.quit();
      }
    });
  }

  containerTest(
    "a stale snapshot id gets a conflict and changes nothing",
    async ({ prisma, redisOptions }) => {
      const { meter, getCounterValue } = createTestMetricsMeter();
      const engine = createEngine(prisma, redisOptions, undefined, meter);

      try {
        const { run, restore, staleSnapshotId } = await dequeueForRestore(engine, prisma);

        for (const outcome of ["requeue", "fail"] as const) {
          const result = await engine.reportRestoreOutcome({
            runId: run.id,
            snapshotId: staleSnapshotId,
            outcome,
            reason: "SnapshotNodeGone",
          });
          expect(result).toEqual({
            ok: false,
            code: "SNAPSHOT_CONFLICT",
            latestSnapshotId: restore.snapshot.id,
            latestExecutionStatus: "PENDING_EXECUTING",
          });
        }
        expect(await getCounterValue("run_engine.restore_outcomes", { result: "conflict" })).toBe(
          2
        );
        expect(await getCounterValue("run_engine.restore_outcomes", { result: "applied" })).toBe(0);

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.id).toBe(restore.snapshot.id);
        expect(executionData.snapshot.executionStatus).toBe("PENDING_EXECUTING");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "fail from a worker of another group gets a conflict and leaves the run",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, restore } = await dequeueForRestore(engine, prisma);

        const result = await engine.reportRestoreOutcome({
          runId: run.id,
          snapshotId: restore.snapshot.id,
          outcome: "fail",
          reason: "SnapshotNotFound",
          servesWorkerQueue: (queue) => queue === "other-group",
        });
        expect(result).toEqual({
          ok: false,
          code: "SNAPSHOT_CONFLICT",
          latestSnapshotId: restore.snapshot.id,
          latestExecutionStatus: "PENDING_EXECUTING",
        });

        const kept = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(kept.workerQueue).toBe("main");
        expect(kept.status).not.toBe("SYSTEM_FAILURE");
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.id).toBe(restore.snapshot.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "fail from a worker serving only the run's restore lane is applied",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);
      const freshLane = "us-east-1:v2:ondemand:fresh:compute:stable";
      const restoreLane = "us-east-1:v2:ondemand:restore:compute:stable";

      try {
        const { run, restore } = await dequeueForRestore(engine, prisma, undefined, {
          workerQueue: freshLane,
          restoreWorkerQueue: restoreLane,
          checkpointType: "COMPUTE",
        });

        const result = await engine.reportRestoreOutcome({
          runId: run.id,
          snapshotId: restore.snapshot.id,
          outcome: "fail",
          reason: "TemplateNotFound",
          servesWorkerQueue: (queue) => queue === restoreLane,
        });
        expect(result).toEqual({ ok: true, outcome: "fail" });

        const kept = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(kept.workerQueue).toBe(freshLane);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("a duplicate report gets a conflict", async ({ prisma, redisOptions }) => {
    const engine = createEngine(prisma, redisOptions);

    try {
      const { run, restore } = await dequeueForRestore(engine, prisma);

      const report = {
        runId: run.id,
        snapshotId: restore.snapshot.id,
        outcome: "requeue" as const,
        reason: "PodStartTimeout",
      };

      const first = await engine.reportRestoreOutcome(report);
      expect(first.ok).toBe(true);

      const afterFirst = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(afterFirst);
      expect(afterFirst.snapshot.executionStatus).toBe("QUEUED");

      const second = await engine.reportRestoreOutcome(report);
      expect(second).toEqual({
        ok: false,
        code: "SNAPSHOT_CONFLICT",
        latestSnapshotId: afterFirst.snapshot.id,
        latestExecutionStatus: "QUEUED",
      });

      const failAfter = await engine.reportRestoreOutcome({ ...report, outcome: "fail" });
      expect(failAfter.ok).toBe(false);

      const afterSecond = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(afterSecond);
      expect(afterSecond.snapshot.id).toBe(afterFirst.snapshot.id);
    } finally {
      await engine.quit();
    }
  });
});

// Dequeues a fresh run, leaving the PENDING_EXECUTING snapshot of a cold start with no checkpoint.
async function dequeueColdStart(engine: RunEngine, prisma: PrismaClient, workerId?: string) {
  const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  const taskIdentifier = "test-task";
  await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

  const run = await engine.trigger(
    {
      number: 1,
      friendlyId: "run_1234",
      environment: authenticatedEnvironment,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      workerQueue: "main",
      queue: "task/test-task",
      isTest: false,
      tags: [],
    },
    prisma
  );

  const dequeued = await dequeue(engine, authenticatedEnvironment.id, "main", workerId);
  expect(dequeued.length).toBe(1);
  assertNonNullable(dequeued[0]);
  expect(dequeued[0].snapshot.executionStatus).toBe("PENDING_EXECUTING");
  expect(dequeued[0].checkpoint).toBeUndefined();

  return { authenticatedEnvironment, run, start: dequeued[0] };
}

describe("RunEngine reportRestoreOutcome for a cold start", () => {
  containerTest(
    "requeue gives the run back without using up an attempt",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { authenticatedEnvironment, run, start } = await dequeueColdStart(engine, prisma);

        const result = await engine.reportRestoreOutcome({
          runId: run.id,
          snapshotId: start.snapshot.id,
          outcome: "requeue",
          reason: "TemplateNotFound",
        });
        expect(result).toEqual({ ok: true, outcome: "requeue" });

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("QUEUED");
        expect(executionData.checkpoint).toBeUndefined();

        const redelivered = await dequeue(engine, authenticatedEnvironment.id);
        expect(redelivered.length).toBe(1);
        assertNonNullable(redelivered[0]);
        expect(redelivered[0].snapshot.executionStatus).toBe("PENDING_EXECUTING");
        expect(redelivered[0].checkpoint).toBeUndefined();
        expect(redelivered[0].run.attemptNumber).toBe(start.run.attemptNumber);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "fail gets a conflict, since there is no checkpoint to lose",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, start } = await dequeueColdStart(engine, prisma);

        const result = await engine.reportRestoreOutcome({
          runId: run.id,
          snapshotId: start.snapshot.id,
          outcome: "fail",
          reason: "TemplateNotFound",
        });
        expect(result).toEqual({
          ok: false,
          code: "SNAPSHOT_CONFLICT",
          latestSnapshotId: start.snapshot.id,
          latestExecutionStatus: "PENDING_EXECUTING",
        });
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "fallback moves the run to the fallback worker queue without a failure",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { authenticatedEnvironment, run, start } = await dequeueColdStart(engine, prisma);

        const fallbackQueues: string[] = [];
        const fallbackWorkerQueue = (queue: string) => {
          fallbackQueues.push(queue);
          return queue === "main" ? "containers" : undefined;
        };
        const result = await engine.reportRestoreOutcome({
          runId: run.id,
          snapshotId: start.snapshot.id,
          outcome: "fallback",
          reason: "TemplateNotFound",
          fallbackWorkerQueue,
        });
        expect(result).toEqual({ ok: true, outcome: "fallback" });
        expect(fallbackQueues).toEqual(["main"]);

        const moved = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(moved.workerQueue).toBe("containers");
        expect(moved.status).toBe("PENDING");

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("QUEUED");
        expect(executionData.checkpoint).toBeUndefined();

        const redelivered = await dequeue(engine, authenticatedEnvironment.id, "containers");
        expect(redelivered.length).toBe(1);
        assertNonNullable(redelivered[0]);
        expect(redelivered[0].run.id).toBe(run.id);
        expect(redelivered[0].checkpoint).toBeUndefined();
        expect(redelivered[0].run.attemptNumber).toBe(start.run.attemptNumber);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "fallback without a worker queue to move to requeues the run where it is",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { authenticatedEnvironment, run, start } = await dequeueColdStart(engine, prisma);

        const result = await engine.reportRestoreOutcome({
          runId: run.id,
          snapshotId: start.snapshot.id,
          outcome: "fallback",
          reason: "TemplateNotFound",
          fallbackWorkerQueue: () => undefined,
        });
        expect(result).toEqual({ ok: true, outcome: "fallback" });

        const kept = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(kept.workerQueue).toBe("main");

        const redelivered = await dequeue(engine, authenticatedEnvironment.id);
        expect(redelivered.length).toBe(1);
        assertNonNullable(redelivered[0]);
        expect(redelivered[0].run.attemptNumber).toBe(start.run.attemptNumber);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "fallback on a stale snapshot gets a conflict and leaves the run's worker queue",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, start } = await dequeueColdStart(engine, prisma);

        const requeued = await engine.reportRestoreOutcome({
          runId: run.id,
          snapshotId: start.snapshot.id,
          outcome: "requeue",
          reason: "TemplateNotFound",
        });
        expect(requeued.ok).toBe(true);
        const afterRequeue = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(afterRequeue);

        const fallbackQueues: string[] = [];
        const fallbackWorkerQueue = (queue: string) => {
          fallbackQueues.push(queue);
          return "containers";
        };
        const result = await engine.reportRestoreOutcome({
          runId: run.id,
          snapshotId: start.snapshot.id,
          outcome: "fallback",
          reason: "TemplateNotFound",
          fallbackWorkerQueue,
        });
        expect(result).toEqual({
          ok: false,
          code: "SNAPSHOT_CONFLICT",
          latestSnapshotId: afterRequeue.snapshot.id,
          latestExecutionStatus: "QUEUED",
        });
        expect(fallbackQueues).toEqual([]);

        const kept = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(kept.workerQueue).toBe("main");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a worker of another group cannot give the run back, and one of the same group can",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, start } = await dequeueColdStart(engine, prisma, "worker_a");

        for (const outcome of ["fallback", "requeue"] as const) {
          const refused = await engine.reportRestoreOutcome({
            runId: run.id,
            snapshotId: start.snapshot.id,
            outcome,
            reason: "TemplateNotFound",
            workerId: "worker_other_group",
            fallbackWorkerQueue: () => "containers",
            servesWorkerQueue: (queue) => queue === "other-group",
          });
          expect(refused).toEqual({
            ok: false,
            code: "SNAPSHOT_CONFLICT",
            latestSnapshotId: start.snapshot.id,
            latestExecutionStatus: "PENDING_EXECUTING",
          });
        }

        const kept = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(kept.workerQueue).toBe("main");

        // Another instance of the dequeuing group, as after a restart.
        const applied = await engine.reportRestoreOutcome({
          runId: run.id,
          snapshotId: start.snapshot.id,
          outcome: "fallback",
          reason: "TemplateNotFound",
          workerId: "worker_a_restarted",
          fallbackWorkerQueue: () => "containers",
          servesWorkerQueue: (queue) => queue === "main",
        });
        expect(applied).toEqual({ ok: true, outcome: "fallback" });

        const moved = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(moved.workerQueue).toBe("containers");
      } finally {
        await engine.quit();
      }
    }
  );

  // The checkpoint can only be restored on the lane that took it.
  containerTest("fallback for a restore gets a conflict", async ({ prisma, redisOptions }) => {
    const engine = createEngine(prisma, redisOptions);

    try {
      const { run, restore } = await dequeueForRestore(engine, prisma);

      const result = await engine.reportRestoreOutcome({
        runId: run.id,
        snapshotId: restore.snapshot.id,
        outcome: "fallback",
        reason: "TemplateNotFound",
        fallbackWorkerQueue: () => "containers",
      });
      expect(result).toMatchObject({ ok: false, code: "SNAPSHOT_CONFLICT" });

      const kept = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(kept.workerQueue).toBe("main");
    } finally {
      await engine.quit();
    }
  });

  containerTest(
    "repeated requeues stop at the queue's attempts and fail the run",
    async ({ prisma, redisOptions }) => {
      const engine = createEngine(prisma, redisOptions, 3);

      try {
        const { authenticatedEnvironment, run, start } = await dequeueColdStart(engine, prisma);

        let snapshotId = start.snapshot.id;
        for (let i = 0; i < 10; i++) {
          const result = await engine.reportRestoreOutcome({
            runId: run.id,
            snapshotId,
            outcome: "requeue",
            reason: "TemplateNotFound",
          });
          expect(result.ok).toBe(true);

          const redelivered = await dequeue(engine, authenticatedEnvironment.id);
          if (redelivered.length === 0) {
            break;
          }
          snapshotId = redelivered[0]!.snapshot.id;
        }

        const finished = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(finished.status).toBe("SYSTEM_FAILURE");
        expect(finished.error).toMatchObject({
          code: "TASK_RUN_DEQUEUED_MAX_RETRIES",
          message: "Starting the run failed more times than we retry.",
        });
      } finally {
        await engine.quit();
      }
    }
  );
});
