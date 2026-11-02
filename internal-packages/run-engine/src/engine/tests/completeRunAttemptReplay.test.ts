import { containerTestWithIsolatedRedis } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { RedisOptions } from "@internal/redis";
import type { TaskRunExecutionResult } from "@trigger.dev/core/v3";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import type { MinimalAuthenticatedEnvironment } from "../../shared/index.js";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

const taskIdentifier = "test-task";

const flushedMetadata = {
  data: JSON.stringify({
    operations: [
      { type: "increment", key: "count", value: 1 },
      { type: "append", key: "log", value: "done" },
    ],
  }),
  dataType: "application/json",
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
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

async function startAttempt(
  engine: RunEngine,
  prisma: PrismaClient,
  environment: MinimalAuthenticatedEnvironment
) {
  const run = await engine.trigger(
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
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );

  await engine.runQueue.processMasterQueueForEnvironment(environment.id, 1);

  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const [dequeued] = await engine.dequeueFromWorkerQueue({
      consumerId: "test_12345",
      workerQueue: "main",
      blockingPopTimeoutSeconds: 1,
    });
    if (dequeued) {
      const attempt = await engine.startRunAttempt({
        runId: run.id,
        snapshotId: dequeued.snapshot.id,
      });
      return { runId: run.id, snapshotId: attempt.snapshot.id };
    }
    await setTimeout(50);
  }

  throw new Error("the run was never dequeued");
}

function recordEvents(engine: RunEngine) {
  const events: string[] = [];
  engine.eventBus.on("runMetadataUpdated", () => events.push("runMetadataUpdated"));
  engine.eventBus.on("runSucceeded", () => events.push("runSucceeded"));
  engine.eventBus.on("runRetryScheduled", () => events.push("runRetryScheduled"));
  return events;
}

describe("RunEngine replayed attempt completion", () => {
  containerTestWithIsolatedRedis(
    "a replayed success applies no metadata and is refused with the latest snapshot",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        await setupBackgroundWorker(engine, environment, taskIdentifier);
        const { runId, snapshotId } = await startAttempt(engine, prisma, environment);
        const events = recordEvents(engine);

        const complete = () =>
          engine.completeRunAttempt({
            runId,
            snapshotId,
            completion: {
              ok: true,
              id: runId,
              output: "{}",
              outputType: "application/json",
              flushedMetadata,
            },
          });

        const first = await complete();
        expect(first.snapshot.executionStatus).toBe("FINISHED");
        expect(events).toEqual(["runMetadataUpdated", "runSucceeded"]);

        const replay = await complete().catch((error: unknown) => error);
        expect(events).toEqual(["runMetadataUpdated", "runSucceeded"]);
        expect(replay).toMatchObject({
          status: 400,
          metadata: { code: "SNAPSHOT_CONFLICT", latestSnapshotId: first.snapshot.id },
        });
      } finally {
        await engine.quit();
      }
    }
  );

  containerTestWithIsolatedRedis(
    "a replayed failure applies no metadata and is refused with the latest snapshot",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        await setupBackgroundWorker(engine, environment, taskIdentifier);
        const { runId, snapshotId } = await startAttempt(engine, prisma, environment);
        const events = recordEvents(engine);

        const completion: TaskRunExecutionResult = {
          ok: false,
          id: runId,
          error: { type: "BUILT_IN_ERROR", name: "UserError", message: "boom", stackTrace: "" },
          retry: { timestamp: Date.now(), delay: 0 },
          flushedMetadata,
        };

        const first = await engine.completeRunAttempt({ runId, snapshotId, completion });
        expect(first.attemptStatus).toBe("RETRY_IMMEDIATELY");
        expect(events).toEqual(["runMetadataUpdated", "runRetryScheduled"]);

        const replay = await engine
          .completeRunAttempt({ runId, snapshotId, completion })
          .catch((error: unknown) => error);
        expect(events).toEqual(["runMetadataUpdated", "runRetryScheduled"]);
        expect(replay).toMatchObject({
          status: 400,
          metadata: { code: "SNAPSHOT_CONFLICT", latestSnapshotId: first.snapshot.id },
        });
      } finally {
        await engine.quit();
      }
    }
  );
});
