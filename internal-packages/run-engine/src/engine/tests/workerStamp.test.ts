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

const triggerAnnotations = {
  triggerSource: "sdk",
  triggerAction: "trigger",
  rootTriggerSource: "sdk",
};

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
    retryWarmStartThresholdMs: 50,
    tracer: trace.getTracer("test", "0.0.0"),
  });
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
  environment: MinimalAuthenticatedEnvironment
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
      annotations: triggerAnnotations,
    },
    prisma
  );
}

describe("RunEngine worker stamp", () => {
  containerTest(
    "startRunAttempt stamps the worker cell and lane into annotations without dropping existing keys",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await trigger(engine, prisma, environment);
        const first = await dequeueOne(engine, environment.id);

        const attempt1 = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: first.snapshot.id,
          workerCell: "cell-a",
          workerLane: "microvm",
        });

        const afterFirst = await prisma.taskRun.findUniqueOrThrow({
          where: { id: run.id },
          select: { annotations: true },
        });
        expect(afterFirst.annotations).toEqual({
          ...triggerAnnotations,
          workerCell: "cell-a",
          workerLane: "microvm",
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

        await engine.startRunAttempt({
          runId: run.id,
          snapshotId: retry.snapshot.id,
          workerCell: "cell-b",
          workerLane: "container",
        });

        const afterRetry = await prisma.taskRun.findUniqueOrThrow({
          where: { id: run.id },
          select: { annotations: true },
        });
        expect(afterRetry.annotations).toEqual({
          ...triggerAnnotations,
          workerCell: "cell-b",
          workerLane: "container",
        });
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "an unstamped retry clears the previous attempt's stamp and keeps the other keys",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await trigger(engine, prisma, environment);
        const first = await dequeueOne(engine, environment.id);

        const attempt1 = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: first.snapshot.id,
          workerCell: "cell-a",
          workerLane: "microvm",
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

        await engine.startRunAttempt({ runId: run.id, snapshotId: retry.snapshot.id });

        const afterRetry = await prisma.taskRun.findUniqueOrThrow({
          where: { id: run.id },
          select: { annotations: true },
        });
        expect(afterRetry.annotations).toEqual(triggerAnnotations);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "startRunAttempt leaves annotations untouched when no stamp is sent",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await trigger(engine, prisma, environment);
        const dequeued = await dequeueOne(engine, environment.id);

        await engine.startRunAttempt({ runId: run.id, snapshotId: dequeued.snapshot.id });

        const after = await prisma.taskRun.findUniqueOrThrow({
          where: { id: run.id },
          select: { annotations: true },
        });
        expect(after.annotations).toEqual(triggerAnnotations);
      } finally {
        await engine.quit();
      }
    }
  );
});
