import { describe, expect, onTestFinished, vi } from "vitest";

// db.server + splitMode are mocked so the idempotency dedup client resolves to
// the container prisma passed into the concern (split stays off).
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  runOpsNewPrisma: {},
  runOpsLegacyPrisma: {},
}));

vi.mock("~/v3/runOpsMigration/splitMode.server", () => ({ isSplitEnabled: async () => false }));

vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEntitlement: vi.fn(),
  };
});

import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "@internal/run-engine/tests";
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import { setTimeout } from "node:timers/promises";
import {
  MockPayloadProcessor,
  MockTraceEventConcern,
  MockTriggerTaskValidator,
} from "./triggerTaskTestHelpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("RunEngineTriggerTaskService", () => {
  containerTest("should trigger a task with minimal options", async ({ prisma, redisOptions }) => {
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
    });
    onTestFinished(() => engine.quit());

    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const taskIdentifier = "test-task";

    await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

    const queuesManager = new DefaultQueueManager(prisma, engine);

    const idempotencyKeyConcern = new IdempotencyKeyConcern(
      prisma,
      engine,
      new MockTraceEventConcern()
    );

    const triggerTaskService = new RunEngineTriggerTaskService({
      engine,
      prisma,
      payloadProcessor: new MockPayloadProcessor(),
      queueConcern: queuesManager,
      idempotencyKeyConcern,
      validator: new MockTriggerTaskValidator(),
      traceEventConcern: new MockTraceEventConcern(),
      tracer: trace.getTracer("test", "0.0.0"),
      metadataMaximumSize: 1024 * 1024 * 1, // 1MB
    });

    const result = await triggerTaskService.call({
      taskId: taskIdentifier,
      environment: authenticatedEnvironment,
      body: { payload: { test: "test" } },
    });

    expect(result).toBeDefined();
    expect(result?.run.friendlyId).toBeDefined();
    expect(result?.run.status).toBe("PENDING");
    expect(result?.isCached).toBe(false);

    const run = await prisma.taskRun.findFirst({
      where: {
        id: result?.run.id,
      },
    });

    expect(run).toBeDefined();
    expect(run?.friendlyId).toBe(result?.run.friendlyId);
    expect(run?.engine).toBe("V2");
    expect(run?.queuedAt).toBeDefined();
    expect(run?.queue).toBe(`task/${taskIdentifier}`);

    // Lets make sure the task is in the queue
    const queueLength = await engine.runQueue.lengthOfQueue(
      authenticatedEnvironment,
      `task/${taskIdentifier}`
    );
    expect(queueLength).toBe(1);
  });

  containerTest(
    "routes scheduled-lineage runs to a separate worker queue that dequeues independently",
    async ({ prisma, redisOptions }) => {
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
          // Disable the background master-queue consumers so our manual
          // processMasterQueueForEnvironment + dequeue calls are deterministic.
          masterQueueConsumersDisabled: true,
          processWorkerQueueDebounceMs: 50,
        },
        runLock: { redis: redisOptions },
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

      try {
        const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

        // Turn the per-org split flag on in-memory — the resolver reads this
        // object directly (no DB round-trip on the trigger hot path).
        (authenticatedEnvironment.organization as { featureFlags?: unknown }).featureFlags = {
          workerQueueScheduledSplitEnabled: true,
        };

        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const triggerTaskService = new RunEngineTriggerTaskService({
          engine,
          prisma,
          payloadProcessor: new MockPayloadProcessor(),
          queueConcern: new DefaultQueueManager(prisma, engine),
          idempotencyKeyConcern: new IdempotencyKeyConcern(
            prisma,
            engine,
            new MockTraceEventConcern()
          ),
          validator: new MockTriggerTaskValidator(),
          traceEventConcern: new MockTraceEventConcern(),
          tracer: trace.getTracer("test", "0.0.0"),
          metadataMaximumSize: 1024 * 1024 * 1,
        });

        // A standard run (default triggerSource) stays on the region queue.
        const standardResult = await triggerTaskService.call({
          taskId: taskIdentifier,
          environment: authenticatedEnvironment,
          body: { payload: { kind: "standard" } },
        });
        assertNonNullable(standardResult);

        // A scheduled run routes to the `<region>:scheduled` queue. Descendants
        // would too, via rootTriggerSource propagation.
        const scheduledResult = await triggerTaskService.call({
          taskId: taskIdentifier,
          environment: authenticatedEnvironment,
          body: { payload: { kind: "scheduled" } },
          options: { triggerSource: "schedule" },
        });
        assertNonNullable(scheduledResult);

        const standardRun = await prisma.taskRun.findUniqueOrThrow({
          where: { id: standardResult.run.id },
        });
        const scheduledRun = await prisma.taskRun.findUniqueOrThrow({
          where: { id: scheduledResult.run.id },
        });

        // Producer routing: the persisted worker queue carries the class.
        const baseWorkerQueue = standardRun.workerQueue;
        expect(scheduledRun.workerQueue).toBe(`${baseWorkerQueue}:scheduled`);

        // Move both runs from the env queue onto their respective worker queues.
        await engine.runQueue.processMasterQueueForEnvironment(authenticatedEnvironment.id, 10);
        await setTimeout(500);

        // Dequeue isolation: the scheduled queue yields only the scheduled run...
        const dequeuedScheduled = await engine.dequeueFromWorkerQueue({
          consumerId: "test-scheduled-consumer",
          workerQueue: `${baseWorkerQueue}:scheduled`,
        });
        expect(dequeuedScheduled.length).toBe(1);
        assertNonNullable(dequeuedScheduled[0]);
        expect(dequeuedScheduled[0].run.id).toBe(scheduledResult.run.id);

        // ...and the base queue yields only the standard run.
        const dequeuedStandard = await engine.dequeueFromWorkerQueue({
          consumerId: "test-standard-consumer",
          workerQueue: baseWorkerQueue,
        });
        expect(dequeuedStandard.length).toBe(1);
        assertNonNullable(dequeuedStandard[0]);
        expect(dequeuedStandard[0].run.id).toBe(standardResult.run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  // The BatchQueue worker rebuilds body.options from Redis-stored items
  // (Record<string, unknown>), so the Phase-2 schema coercion doesn't apply
  // to in-flight items enqueued before the schema fix. The defensive
  // `typeof === "number"` coercion at the engine.trigger call site is what
  // prevents these from failing at prisma.taskRun.create with
  // "Argument concurrencyKey: Expected String or Null, provided Int".
  containerTest(
    "coerces a numeric concurrencyKey to a string at the engine.trigger boundary",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
        },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
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
      onTestFinished(() => engine.quit());

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: new DefaultQueueManager(prisma, engine),
        idempotencyKeyConcern: new IdempotencyKeyConcern(
          prisma,
          engine,
          new MockTraceEventConcern()
        ),
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024 * 1,
      });

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        // Cast through `any` to simulate the in-flight Redis batch-item shape
        // (Record<string, unknown>) that bypasses the BatchItemNDJSON schema.
        body: { payload: { userId: 51262 }, options: { concurrencyKey: 51262 as any } },
      });

      expect(result).toBeDefined();
      const run = await prisma.taskRun.findFirst({ where: { id: result!.run.id } });
      expect(run?.concurrencyKey).toBe("51262");
    }
  );
});
