import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "@internal/redis";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import type { MinimalAuthenticatedEnvironment } from "../../shared/index.js";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const taskIdentifier = "test-task";
const queueName = `task/${taskIdentifier}`;

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
    // Force delayed retries back through the queue so the retry is dequeued again.
    retryWarmStartThresholdMs: 50,
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

async function archiveQueue(prisma: PrismaClient, environmentId: string) {
  const queue = await prisma.taskQueue.update({
    where: { runtimeEnvironmentId_name: { runtimeEnvironmentId: environmentId, name: queueName } },
    data: { archivedAt: new Date() },
  });
  assertNonNullable(queue.archivedAt);
  return queue;
}

async function dequeueOne(engine: RunEngine, environmentId: string) {
  await engine.runQueue.processMasterQueueForEnvironment(environmentId, 1);
  await setTimeout(300);
  const dequeued = await engine.dequeueFromWorkerQueue({
    consumerId: "test_12345",
    workerQueue: "main",
  });
  expect(dequeued.length).toBe(1);
  assertNonNullable(dequeued[0]);
  return dequeued[0];
}

async function trigger(
  engine: RunEngine,
  prisma: PrismaClient,
  environment: MinimalAuthenticatedEnvironment,
  lock?: { lockedToVersionId: string; lockedQueueId: string }
) {
  return engine.trigger(
    {
      number: 1,
      friendlyId: `run_${Math.random().toString(36).slice(2, 10)}`,
      environment,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      workerQueue: "main",
      queue: queueName,
      isTest: false,
      tags: [],
      ...lock,
    },
    prisma
  );
}

describe("RunEngine archived queues", () => {
  containerTest(
    "unlocked run on an archived queue dequeues, retries through the queue and completes",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        await setupBackgroundWorker(engine, environment, taskIdentifier);
        await archiveQueue(prisma, environment.id);

        const run = await trigger(engine, prisma, environment);

        const first = await dequeueOne(engine, environment.id);
        expect(first.run.id).toBe(run.id);

        const attempt1 = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: first.snapshot.id,
        });

        const failed = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attempt1.snapshot.id,
          completion: {
            ok: false,
            id: run.id,
            error: { type: "BUILT_IN_ERROR", name: "UserError", message: "boom", stackTrace: "" },
            retry: { timestamp: Date.now() + 200, delay: 200 },
          },
        });
        expect(failed.attemptStatus).toBe("RETRY_QUEUED");

        await setTimeout(400);
        const retry = await dequeueOne(engine, environment.id);
        expect(retry.run.id).toBe(run.id);

        const attempt2 = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: retry.snapshot.id,
        });
        expect(attempt2.run.attemptNumber).toBe(2);

        const completed = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attempt2.snapshot.id,
          completion: { ok: true, id: run.id, output: "{}", outputType: "application/json" },
        });
        expect(completed.run.status).toBe("COMPLETED_SUCCESSFULLY");

        const snapshots = await prisma.taskRunExecutionSnapshot.findMany({
          where: { runId: run.id },
        });
        expect(snapshots.some((s) => s.executionStatus === "PENDING_VERSION")).toBe(false);

        // The engine never touches the archive flag.
        const queue = await prisma.taskQueue.findFirstOrThrow({
          where: { runtimeEnvironmentId: environment.id, name: queueName },
        });
        expect(queue.archivedAt).not.toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "version-locked run on an archived queue dequeues and completes",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const { worker } = await setupBackgroundWorker(engine, environment, taskIdentifier);
        const queue = await archiveQueue(prisma, environment.id);

        const run = await trigger(engine, prisma, environment, {
          lockedToVersionId: worker.id,
          lockedQueueId: queue.id,
        });

        const dequeued = await dequeueOne(engine, environment.id);
        expect(dequeued.run.id).toBe(run.id);

        const attempt = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: dequeued.snapshot.id,
        });

        const completed = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          completion: { ok: true, id: run.id, output: "{}", outputType: "application/json" },
        });
        expect(completed.run.status).toBe("COMPLETED_SUCCESSFULLY");

        const snapshots = await prisma.taskRunExecutionSnapshot.findMany({
          where: { runId: run.id },
        });
        expect(snapshots.some((s) => s.executionStatus === "PENDING_VERSION")).toBe(false);
      } finally {
        await engine.quit();
      }
    }
  );
});
