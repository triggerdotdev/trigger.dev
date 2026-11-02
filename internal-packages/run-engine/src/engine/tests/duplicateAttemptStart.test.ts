import { assertNonNullable, containerTest } from "@internal/testcontainers";
import type { Meter } from "@internal/tracing";
import { trace } from "@internal/tracing";
import type { PrismaClient } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import { ServiceValidationError } from "../errors.js";
import { RunEngine } from "../index.js";
import type { RunEngineOptions } from "../types.js";
import { createTestMetricsMeter } from "./helpers/replicaTestHelpers.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function createEngine(
  prisma: PrismaClient,
  redisOptions: any,
  opts: {
    meter?: Meter;
    duplicateAttemptStartCheck?: RunEngineOptions["duplicateAttemptStartCheck"];
  } = {}
) {
  return new RunEngine({
    prisma,
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
    duplicateAttemptStartCheck: opts.duplicateAttemptStartCheck,
    tracer: trace.getTracer("test", "0.0.0"),
    meter: opts.meter,
  });
}

const retryError = {
  type: "BUILT_IN_ERROR" as const,
  name: "Error",
  message: "boom",
  stackTrace: "Error: boom",
};

/** Triggers a run, dequeues it and starts its first attempt as "runner-a". */
async function startFirst(engine: RunEngine, prisma: PrismaClient) {
  const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  await setupBackgroundWorker(engine, environment, "test-task", undefined, {
    maxAttempts: 3,
    factor: 1,
    minTimeoutInMs: 10,
    maxTimeoutInMs: 10,
    randomize: false,
  });
  const run = await engine.trigger(
    {
      number: 1,
      friendlyId: "run_1234",
      environment,
      taskIdentifier: "test-task",
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
  await engine.runQueue.processMasterQueueForEnvironment(environment.id);
  const dequeued = await engine.dequeueFromWorkerQueue({
    consumerId: "test_12345",
    workerQueue: "main",
  });
  expect(dequeued.length).toBe(1);
  assertNonNullable(dequeued[0]);

  const first = await engine.startRunAttempt({
    runId: run.id,
    snapshotId: dequeued[0].snapshot.id,
    runnerId: "runner-a",
  });
  expect(first.snapshot.executionStatus).toBe("EXECUTING");
  return { run, dequeued: dequeued[0], first };
}

describe("RunEngine startRunAttempt on a run already executing", () => {
  containerTest("is refused when enforced", async ({ prisma, redisOptions }) => {
    const { meter, getCounterValue } = createTestMetricsMeter();
    const engine = createEngine(prisma, redisOptions, {
      meter,
      duplicateAttemptStartCheck: "enforce",
    });
    try {
      const { run, first } = await startFirst(engine, prisma);

      const second = await engine
        .startRunAttempt({ runId: run.id, snapshotId: first.snapshot.id, runnerId: "runner-b" })
        .catch((e) => e);
      expect(second).toBeInstanceOf(ServiceValidationError);
      expect(second.status).toBe(409);
      expect(second.metadata).toEqual({ code: "ATTEMPT_ALREADY_EXECUTING" });

      const dbRun = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(dbRun.attemptNumber).toBe(1);
      expect(
        await getCounterValue("run_engine.duplicate_attempt_starts", { outcome: "refused" })
      ).toBe(1);
    } finally {
      await engine.quit();
    }
  });

  containerTest("is logged and allowed by default", async ({ prisma, redisOptions }) => {
    const { meter, getCounterValue } = createTestMetricsMeter();
    const engine = createEngine(prisma, redisOptions, { meter });
    try {
      const { run, first } = await startFirst(engine, prisma);

      const second = await engine.startRunAttempt({
        runId: run.id,
        snapshotId: first.snapshot.id,
      });
      expect(second.run.attemptNumber).toBe(2);
      expect(
        await getCounterValue("run_engine.duplicate_attempt_starts", { outcome: "logged" })
      ).toBe(1);
    } finally {
      await engine.quit();
    }
  });

  containerTest("is neither counted nor refused when off", async ({ prisma, redisOptions }) => {
    const { meter, getCounterValue } = createTestMetricsMeter();
    const engine = createEngine(prisma, redisOptions, { meter, duplicateAttemptStartCheck: "off" });
    try {
      const { run, first } = await startFirst(engine, prisma);

      const second = await engine.startRunAttempt({
        runId: run.id,
        snapshotId: first.snapshot.id,
      });
      expect(second.run.attemptNumber).toBe(2);
      expect(await getCounterValue("run_engine.duplicate_attempt_starts")).toBe(0);
    } finally {
      await engine.quit();
    }
  });

  containerTest(
    "a start retried with the dequeued snapshot after a lost response is still a snapshot conflict",
    async ({ prisma, redisOptions }) => {
      const { meter, getCounterValue } = createTestMetricsMeter();
      const engine = createEngine(prisma, redisOptions, {
        meter,
        duplicateAttemptStartCheck: "enforce",
      });
      try {
        const { run, dequeued } = await startFirst(engine, prisma);

        const retried = await engine
          .startRunAttempt({
            runId: run.id,
            snapshotId: dequeued.snapshot.id,
            runnerId: "runner-a",
          })
          .catch((e) => e);
        expect(retried).toBeInstanceOf(ServiceValidationError);
        expect(retried.message).toBe("Snapshot changed inside startRunAttempt");
        expect(await getCounterValue("run_engine.duplicate_attempt_starts")).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "an immediate retry still starts the next attempt when enforced",
    async ({ prisma, redisOptions }) => {
      const { meter, getCounterValue } = createTestMetricsMeter();
      const engine = createEngine(prisma, redisOptions, {
        meter,
        duplicateAttemptStartCheck: "enforce",
      });
      try {
        const { run, first } = await startFirst(engine, prisma);

        const result = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: first.snapshot.id,
          runnerId: "runner-a",
          completion: {
            ok: false,
            id: run.id,
            error: retryError,
            retry: { timestamp: Date.now(), delay: 0 },
          },
        });
        expect(result.attemptStatus).toBe("RETRY_IMMEDIATELY");
        expect(result.snapshot.executionStatus).toBe("EXECUTING");

        const retry = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: result.snapshot.id,
          runnerId: "runner-a",
        });
        expect(retry.run.attemptNumber).toBe(2);

        // The retry's own attempt is now executing, so starting from its snapshot is refused.
        await expect(
          engine.startRunAttempt({ runId: run.id, snapshotId: retry.snapshot.id })
        ).rejects.toMatchObject({ status: 409 });
        expect(
          await getCounterValue("run_engine.duplicate_attempt_starts", { outcome: "refused" })
        ).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );
});
