import { assertNonNullable, containerTestWithIsolatedRedis } from "@internal/testcontainers";
import type { Meter } from "@internal/tracing";
import { trace } from "@internal/tracing";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { describe, expect, vi } from "vitest";
import { RunEngine } from "../index.js";
import { createTestMetricsMeter } from "./helpers/replicaTestHelpers.js";
import {
  type AuthenticatedEnvironment,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
} from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const taskIdentifier = "test-task";
const queueName = "task/test-task";

function createEngine(prisma: PrismaClient, redisOptions: any, queueMaxAttempts?: number) {
  const { meter, getCounterValue } = createTestMetricsMeter();
  const engine = new RunEngine({
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
    meter: meter as Meter,
  });
  return { engine, getCounterValue };
}

async function dequeueNext(
  engine: RunEngine,
  environment: AuthenticatedEnvironment,
  workerQueue = "main"
) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    await engine.runQueue.processMasterQueueForEnvironment(environment.id);
    const [message] = await engine.dequeueFromWorkerQueue({
      consumerId: "test_12345",
      workerQueue,
      blockingPopTimeoutSeconds: 1,
    });
    if (message) {
      return message;
    }
    await setTimeout(20);
  }
  throw new Error("nothing was dequeued");
}

async function triggerAndDequeue(engine: RunEngine, prisma: PrismaClient, workerQueue = "main") {
  const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  await setupBackgroundWorker(engine, environment, taskIdentifier);

  const run = await engine.trigger(
    {
      number: 1,
      friendlyId: "run_1234",
      environment,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      workerQueue,
      queue: queueName,
      isTest: false,
      tags: [],
    },
    prisma
  );

  const dequeued = await dequeueNext(engine, environment, workerQueue);
  expect(dequeued.snapshot.executionStatus).toBe("PENDING_EXECUTING");

  return { environment, run, dequeued };
}

/** A run checkpointed at a waitpoint and dequeued again as a restore, on `restoreQueue`. */
async function checkpointAndRedeliver(
  engine: RunEngine,
  prisma: PrismaClient,
  workerQueue = "main",
  restoreQueue = workerQueue
) {
  const { environment, run, dequeued } = await triggerAndDequeue(engine, prisma, workerQueue);
  await engine.startRunAttempt({ runId: run.id, snapshotId: dequeued.snapshot.id });

  const waitpoint = await engine.createManualWaitpoint({
    environmentId: environment.id,
    projectId: environment.projectId,
  });
  const blocked = await engine.blockRunWithWaitpoint({
    runId: run.id,
    waitpoints: waitpoint.waitpoint.id,
    projectId: environment.projectId,
    organizationId: environment.organizationId,
  });
  const checkpoint = await engine.createCheckpoint({
    runId: run.id,
    snapshotId: blocked.id,
    checkpoint: {
      type: "DOCKER",
      reason: "TEST_CHECKPOINT",
      location: "test-location",
      imageRef: "test-image-ref",
    },
  });
  expect(checkpoint.ok).toBe(true);
  await engine.completeWaitpoint({ id: waitpoint.waitpoint.id });

  const restore = await dequeueNext(engine, environment, restoreQueue);
  const restored = restore.checkpoint;
  assertNonNullable(restored);

  return { environment, run, restore, checkpoint: restored };
}

async function concurrencyOf(engine: RunEngine, environment: AuthenticatedEnvironment) {
  return {
    environment: await engine.runQueue.currentConcurrencyOfEnvironment(environment),
    operational: await engine.runQueue.operationalCurrentConcurrencyOfEnvironment(environment),
    queue: await engine.runQueue.currentConcurrencyOfQueue(environment, queueName),
  };
}

describe("RunEngine releaseRun", () => {
  containerTestWithIsolatedRedis(
    "requeues a dequeued run, charging one dequeue attempt, and gives back its concurrency",
    async ({ prisma, redisOptions }) => {
      const { engine, getCounterValue } = createEngine(prisma, redisOptions);

      try {
        const { environment, run, dequeued } = await triggerAndDequeue(engine, prisma);
        expect(await concurrencyOf(engine, environment)).toEqual({
          environment: 1,
          operational: 1,
          queue: 1,
        });

        const result = await engine.releaseRun({
          runId: run.id,
          snapshotId: dequeued.snapshot.id,
          reason: "PodFailed",
        });
        expect(result).toEqual({ ok: true, requeued: true });

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("QUEUED");
        expect(executionData.snapshot.description).toBe(
          "Released before the run started: PodFailed"
        );
        const releasedSnapshot = await prisma.taskRunExecutionSnapshot.findFirstOrThrow({
          where: { id: executionData.snapshot.id },
        });
        expect(releasedSnapshot.previousSnapshotId).toBe(dequeued.snapshot.id);
        expect(await concurrencyOf(engine, environment)).toEqual({
          environment: 0,
          operational: 0,
          queue: 0,
        });
        expect(
          (await engine.runQueue.readMessage(environment.organizationId, run.id))?.attempt
        ).toBe(1);
        expect(
          await getCounterValue("run_engine.run_releases", {
            reason: "PodFailed",
            result: "requeued",
          })
        ).toBe(1);

        const redelivered = await dequeueNext(engine, environment);
        expect(redelivered.run.id).toBe(run.id);
        expect(redelivered.snapshot.executionStatus).toBe("PENDING_EXECUTING");

        const attempt = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: redelivered.snapshot.id,
        });
        expect(attempt.run.attemptNumber).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "refuses a snapshot that is no longer the latest and changes nothing",
    async ({ prisma, redisOptions }) => {
      const { engine, getCounterValue } = createEngine(prisma, redisOptions);

      try {
        const { environment, run, dequeued } = await triggerAndDequeue(engine, prisma);
        const started = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: dequeued.snapshot.id,
        });

        const result = await engine.releaseRun({
          runId: run.id,
          snapshotId: dequeued.snapshot.id,
          reason: "PodFailed",
        });
        expect(result).toEqual({
          ok: false,
          code: "SNAPSHOT_CONFLICT",
          latestSnapshotId: started.snapshot.id,
          latestExecutionStatus: "EXECUTING",
        });

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.id).toBe(started.snapshot.id);
        expect(await concurrencyOf(engine, environment)).toEqual({
          environment: 1,
          operational: 1,
          queue: 1,
        });
        expect(
          await getCounterValue("run_engine.run_releases", {
            reason: "PodFailed",
            result: "conflict",
          })
        ).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "refuses a second release of the same snapshot",
    async ({ prisma, redisOptions }) => {
      const { engine } = createEngine(prisma, redisOptions);

      try {
        const { environment, run, dequeued } = await triggerAndDequeue(engine, prisma);
        const release = { runId: run.id, snapshotId: dequeued.snapshot.id, reason: "PodFailed" };

        expect(await engine.releaseRun(release)).toEqual({ ok: true, requeued: true });
        const afterFirst = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(afterFirst);

        expect(await engine.releaseRun(release)).toEqual({
          ok: false,
          code: "SNAPSHOT_CONFLICT",
          latestSnapshotId: afterFirst.snapshot.id,
          latestExecutionStatus: "QUEUED",
        });
        expect(
          await engine.releaseRun({ ...release, snapshotId: afterFirst.snapshot.id })
        ).toMatchObject({ ok: false, code: "SNAPSHOT_CONFLICT" });
        expect(
          (await engine.runQueue.readMessage(environment.organizationId, run.id))?.attempt
        ).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "refuses a worker that does not serve the run's worker queue",
    async ({ prisma, redisOptions }) => {
      const { engine, getCounterValue } = createEngine(prisma, redisOptions);

      try {
        const { run, dequeued } = await triggerAndDequeue(engine, prisma);

        const refused = await engine.releaseRun({
          runId: run.id,
          snapshotId: dequeued.snapshot.id,
          reason: "PodFailed",
          servesWorkerQueue: (workerQueue) => workerQueue === "other-group",
        });
        expect(refused).toMatchObject({
          ok: false,
          code: "SNAPSHOT_CONFLICT",
          latestSnapshotId: dequeued.snapshot.id,
        });

        const released = await engine.releaseRun({
          runId: run.id,
          snapshotId: dequeued.snapshot.id,
          reason: "CreateFailed",
          servesWorkerQueue: (workerQueue) => workerQueue === "main",
        });
        expect(released).toEqual({ ok: true, requeued: true });
        expect(
          await getCounterValue("run_engine.run_releases", {
            reason: "CreateFailed",
            result: "requeued",
          })
        ).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "keeps a restore's checkpoint when it is released",
    async ({ prisma, redisOptions }) => {
      const { engine } = createEngine(prisma, redisOptions);

      try {
        const { environment, run, restore, checkpoint } = await checkpointAndRedeliver(
          engine,
          prisma
        );

        const result = await engine.releaseRun({
          runId: run.id,
          snapshotId: restore.snapshot.id,
          reason: "PodFailed",
        });
        expect(result).toEqual({ ok: true, requeued: true });

        const redelivered = await dequeueNext(engine, environment);
        expect(redelivered.snapshot.executionStatus).toBe("PENDING_EXECUTING");
        expect(redelivered.checkpoint?.id).toBe(checkpoint.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "accepts a restore's release from a worker that serves only its restore queue",
    async ({ prisma, redisOptions }) => {
      const { engine } = createEngine(prisma, redisOptions);
      const freshQueue = "us-east-1:v2:ondemand:fresh:any:stable";
      const restoreQueue = "us-east-1:v2:ondemand:restore:container:stable";

      try {
        const { environment, run, restore, checkpoint } = await checkpointAndRedeliver(
          engine,
          prisma,
          freshQueue,
          restoreQueue
        );

        const refused = await engine.releaseRun({
          runId: run.id,
          snapshotId: restore.snapshot.id,
          reason: "PodFailed",
          servesWorkerQueue: (workerQueue) => workerQueue === "other-group",
        });
        expect(refused).toMatchObject({ ok: false, code: "SNAPSHOT_CONFLICT" });

        const released = await engine.releaseRun({
          runId: run.id,
          snapshotId: restore.snapshot.id,
          reason: "PodFailed",
          servesWorkerQueue: (workerQueue) => workerQueue === restoreQueue,
        });
        expect(released).toEqual({ ok: true, requeued: true });

        const redelivered = await dequeueNext(engine, environment, restoreQueue);
        expect(redelivered.checkpoint?.id).toBe(checkpoint.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "refuses a run that was cancelled while it waited to start",
    async ({ prisma, redisOptions }) => {
      const { engine, getCounterValue } = createEngine(prisma, redisOptions);

      try {
        const { run, dequeued } = await triggerAndDequeue(engine, prisma);
        await engine.cancelRun({
          runId: run.id,
          completedAt: new Date(),
          reason: "Cancelled by the user",
        });

        const refused = await engine.releaseRun({
          runId: run.id,
          snapshotId: dequeued.snapshot.id,
          reason: "PodFailed",
        });
        expect(refused).toMatchObject({
          ok: false,
          code: "SNAPSHOT_CONFLICT",
          latestExecutionStatus: "PENDING_CANCEL",
        });

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        expect(executionData?.snapshot.executionStatus).toBe("PENDING_CANCEL");
        expect(
          await getCounterValue("run_engine.run_releases", {
            reason: "PodFailed",
            result: "conflict",
          })
        ).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "counts releases against the dequeue budget and fails the run once it is used up",
    async ({ prisma, redisOptions }) => {
      const queueMaxAttempts = 3;
      const { engine, getCounterValue } = createEngine(prisma, redisOptions, queueMaxAttempts);

      try {
        const { environment, run, dequeued } = await triggerAndDequeue(engine, prisma);

        let snapshotId = dequeued.snapshot.id;
        for (let release = 1; release < queueMaxAttempts; release++) {
          const result = await engine.releaseRun({
            runId: run.id,
            snapshotId,
            reason: "PodFailed",
          });
          expect(result).toEqual({ ok: true, requeued: true });
          snapshotId = (await dequeueNext(engine, environment)).snapshot.id;
        }

        const last = await engine.releaseRun({ runId: run.id, snapshotId, reason: "PodFailed" });
        expect(last).toEqual({ ok: true, requeued: false });

        const failed = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(failed.status).toBe("SYSTEM_FAILURE");
        expect(failed.error).toMatchObject({
          code: "TASK_RUN_DEQUEUED_MAX_RETRIES",
          message: "Starting the run failed more times than we retry.",
        });
        expect(await concurrencyOf(engine, environment)).toEqual({
          environment: 0,
          operational: 0,
          queue: 0,
        });
        expect(await getCounterValue("run_engine.run_releases", { result: "requeued" })).toBe(
          queueMaxAttempts - 1
        );
        expect(await getCounterValue("run_engine.run_releases", { result: "dropped" })).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );
});
