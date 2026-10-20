import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "@internal/redis";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { LockAcquisitionTimeoutError } from "../locking.js";
import { CONTINUED_AFTER_SUSPENDED_DESCRIPTION } from "../systems/checkpointSystem.js";
import { setTimeout } from "node:timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function createEngine(prisma: PrismaClient, redisOptions: RedisOptions) {
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
    },
    runLock: {
      redis: redisOptions,
      // Give up on a held lock quickly instead of after the default 15s.
      retryConfig: { maxAttempts: 3, baseDelay: 50, maxDelay: 100, maxTotalWaitTime: 500 },
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
  });
}

/** Triggers a task run and dequeues it, which leaves it PENDING_EXECUTING. */
async function triggerAndDequeue(
  engine: RunEngine,
  prisma: PrismaClient,
  environment: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>
) {
  const taskIdentifier = "test-task";
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
      workerQueue: "main",
      queue: "task/test-task",
      isTest: false,
      tags: [],
    },
    prisma
  );

  await setTimeout(500);
  const dequeued = await engine.dequeueFromWorkerQueue({
    consumerId: "test_12345",
    workerQueue: "main",
  });
  assertNonNullable(dequeued[0]);

  return { run, pendingSnapshotId: dequeued[0].snapshot.id };
}

/**
 * Runs a task up to the point where it has been restored from a checkpoint and is waiting
 * for `continue`: executing, blocked on a manual waitpoint, checkpointed, waitpoint completed,
 * dequeued again. Returns the PENDING_EXECUTING snapshot id that `continue` is called with.
 */
async function restoreFromCheckpoint(
  engine: RunEngine,
  prisma: PrismaClient,
  environment: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>
) {
  const dequeued = await triggerAndDequeue(engine, prisma, environment);
  const { run } = dequeued;

  await engine.startRunAttempt({ runId: run.id, snapshotId: dequeued.pendingSnapshotId });

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
  await setTimeout(500);

  const restored = await engine.dequeueFromWorkerQueue({
    consumerId: "test_12345",
    workerQueue: "main",
  });
  assertNonNullable(restored[0]);
  expect(restored[0].snapshot.executionStatus).toBe("PENDING_EXECUTING");

  return { run, pendingSnapshotId: restored[0].snapshot.id };
}

describe("RunEngine continueRunExecution retries", () => {
  containerTest(
    "a retry after the continue already succeeded gets the same result",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, pendingSnapshotId } = await restoreFromCheckpoint(engine, prisma, environment);

        // The first request succeeds, but its response never reaches the runner (e.g. the
        // request was cut off by the load balancer while the handler kept running).
        const first = await engine.continueRunExecution({
          runId: run.id,
          snapshotId: pendingSnapshotId,
          runnerId: "runner_a",
        });
        expect(first.snapshot.executionStatus).toBe("EXECUTING");
        expect(first.snapshot.description).toBe(CONTINUED_AFTER_SUSPENDED_DESCRIPTION);

        const notifications: string[] = [];
        engine.eventBus.on("workerNotification", ({ snapshot }) => notifications.push(snapshot.id));
        const worker = (engine as any).worker;
        const heartbeatBefore = await worker.getJob(`heartbeatSnapshot.${run.id}`);
        assertNonNullable(heartbeatBefore);
        await setTimeout(50);

        // The same runner retries with the same snapshot id.
        const retry = await engine.continueRunExecution({
          runId: run.id,
          snapshotId: pendingSnapshotId,
          runnerId: "runner_a",
        });

        expect(retry.snapshot.id).toBe(first.snapshot.id);
        expect(retry.snapshot.executionStatus).toBe("EXECUTING");
        expect(retry.run.status).toBe("EXECUTING");

        // The retry created nothing new.
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        expect(executionData?.snapshot.id).toBe(first.snapshot.id);

        // It gave the run a fresh heartbeat deadline and told the worker again.
        const heartbeatAfter = await worker.getJob(`heartbeatSnapshot.${run.id}`);
        assertNonNullable(heartbeatAfter);
        expect(heartbeatAfter.item.snapshotId).toBe(first.snapshot.id);
        expect(heartbeatAfter.timestamp.getTime()).toBeGreaterThan(
          heartbeatBefore.timestamp.getTime()
        );
        expect(notifications).toEqual([first.snapshot.id]);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a retry from a different runner is still rejected",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, pendingSnapshotId } = await restoreFromCheckpoint(engine, prisma, environment);

        await engine.continueRunExecution({
          runId: run.id,
          snapshotId: pendingSnapshotId,
          runnerId: "runner_a",
        });

        await expect(
          engine.continueRunExecution({
            runId: run.id,
            snapshotId: pendingSnapshotId,
            runnerId: "runner_b",
          })
        ).rejects.toThrow("Snapshot ID doesn't match the latest snapshot");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a retry after the run has moved on is still rejected",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, pendingSnapshotId } = await restoreFromCheckpoint(engine, prisma, environment);

        await engine.continueRunExecution({
          runId: run.id,
          snapshotId: pendingSnapshotId,
          runnerId: "runner_a",
        });

        // The run carries on and blocks on another waitpoint, so the snapshot created by
        // the continue is no longer the latest one.
        const waitpoint = await engine.createManualWaitpoint({
          environmentId: environment.id,
          projectId: environment.projectId,
        });
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.waitpoint.id,
          projectId: environment.projectId,
          organizationId: environment.organizationId,
        });

        await expect(
          engine.continueRunExecution({
            runId: run.id,
            snapshotId: pendingSnapshotId,
            runnerId: "runner_a",
          })
        ).rejects.toThrow("Snapshot ID doesn't match the latest snapshot");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a retry without a runner id gets the same result when the first continue had none",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, pendingSnapshotId } = await restoreFromCheckpoint(engine, prisma, environment);

        const first = await engine.continueRunExecution({
          runId: run.id,
          snapshotId: pendingSnapshotId,
        });

        const retry = await engine.continueRunExecution({
          runId: run.id,
          snapshotId: pendingSnapshotId,
        });

        expect(retry.snapshot.id).toBe(first.snapshot.id);
        expect(retry.snapshot.executionStatus).toBe("EXECUTING");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a continue is rejected when the latest snapshot was written by something other than a continue",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, pendingSnapshotId } = await triggerAndDequeue(engine, prisma, environment);

        // Starting the attempt writes an EXECUTING snapshot whose previous snapshot is the
        // PENDING_EXECUTING one, as a continue would, but it isn't a continue.
        await engine.startRunAttempt({ runId: run.id, snapshotId: pendingSnapshotId });

        await expect(
          engine.continueRunExecution({ runId: run.id, snapshotId: pendingSnapshotId })
        ).rejects.toThrow("Snapshot ID doesn't match the latest snapshot");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a continue that can't get the run lock fails with a lock acquisition timeout",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const { run, pendingSnapshotId } = await restoreFromCheckpoint(engine, prisma, environment);

        // Another request holds the run lock, e.g. an earlier continue that was cut off but is
        // still running. The lock is held from its own promise so the continue below runs
        // outside the lock's context and has to wait for it.
        let markHeld!: () => void;
        let release!: () => void;
        const held = new Promise<void>((resolve) => (markHeld = resolve));
        const released = new Promise<void>((resolve) => (release = resolve));
        const holder = (engine as any).runLock.lock("test-holder", [run.id], async () => {
          markHeld();
          await released;
        });
        await held;

        try {
          await expect(
            engine.continueRunExecution({
              runId: run.id,
              snapshotId: pendingSnapshotId,
              runnerId: "runner_a",
            })
          ).rejects.toBeInstanceOf(LockAcquisitionTimeoutError);
        } finally {
          release();
          await holder;
        }

        // Once the lock is free, the same continue goes through.
        const continued = await engine.continueRunExecution({
          runId: run.id,
          snapshotId: pendingSnapshotId,
          runnerId: "runner_a",
        });
        expect(continued.snapshot.executionStatus).toBe("EXECUTING");
      } finally {
        await engine.quit();
      }
    }
  );
});
