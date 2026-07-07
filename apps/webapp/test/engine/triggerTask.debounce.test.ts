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
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import type { IOPacket } from "@trigger.dev/core/v3";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import type { PayloadProcessor, TriggerTaskRequest } from "~/runEngine/types";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import { setTimeout } from "node:timers/promises";
import {
  MockPayloadProcessor,
  MockTraceEventConcern,
  MockTriggerRacepointSystem,
  MockTriggerTaskValidator,
} from "./triggerTaskTestHelpers";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

describe("RunEngineTriggerTaskService", () => {
  containerTest(
    "should preserve runFriendlyId across retries when RunDuplicateIdempotencyKeyError is thrown",
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
        logLevel: "debug",
      });
      onTestFinished(() => engine.quit());

      const parentTask = "parent-task";
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "test-task";

      // Create background worker
      await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, taskIdentifier]);

      // Create parent runs and start their attempts (required for resumeParentOnCompletion)
      const parentRun1 = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_cmqxvncxq0000kaulzpafkicv",
          environment: authenticatedEnvironment,
          taskIdentifier: parentTask,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          queue: `task/${parentTask}`,
          isTest: false,
          tags: [],
          workerQueue: "main",
        },
        prisma
      );

      await setTimeout(500);
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      await engine.startRunAttempt({
        runId: parentRun1.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      const parentRun2 = await engine.trigger(
        {
          number: 2,
          friendlyId: "run_cmqxvncxr0001kauldv9mqa9z",
          environment: authenticatedEnvironment,
          taskIdentifier: parentTask,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12346",
          spanId: "s12346",
          queue: `task/${parentTask}`,
          isTest: false,
          tags: [],
          workerQueue: "main",
        },
        prisma
      );

      await setTimeout(500);
      const dequeued2 = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      await engine.startRunAttempt({
        runId: parentRun2.id,
        snapshotId: dequeued2[0].snapshot.id,
      });

      const queuesManager = new DefaultQueueManager(prisma, engine);
      const idempotencyKeyConcern = new IdempotencyKeyConcern(
        prisma,
        engine,
        new MockTraceEventConcern()
      );

      const triggerRacepointSystem = new MockTriggerRacepointSystem();

      // Track all friendlyIds passed to the payload processor
      const processedFriendlyIds: string[] = [];
      class TrackingPayloadProcessor implements PayloadProcessor {
        async process(request: TriggerTaskRequest): Promise<IOPacket> {
          processedFriendlyIds.push(request.friendlyId);
          return {
            data: JSON.stringify(request.body.payload),
            dataType: "application/json",
          };
        }
      }

      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new TrackingPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024 * 1, // 1MB
        triggerRacepointSystem,
      });

      const idempotencyKey = "test-preserve-friendly-id";
      const racepoint = triggerRacepointSystem.registerRacepoint("idempotencyKey", idempotencyKey);

      // Trigger two concurrent requests with same idempotency key
      // One will succeed, one will fail with RunDuplicateIdempotencyKeyError and retry
      const childTriggerPromise1 = triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test1" },
          options: {
            idempotencyKey,
            parentRunId: parentRun1.friendlyId,
            resumeParentOnCompletion: true,
          },
        },
      });

      const childTriggerPromise2 = triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test2" },
          options: {
            idempotencyKey,
            parentRunId: parentRun2.friendlyId,
            resumeParentOnCompletion: true,
          },
        },
      });

      await setTimeout(500);

      // Resolve the racepoint to allow both requests to proceed
      racepoint.resolve();

      const result1 = await childTriggerPromise1;
      const result2 = await childTriggerPromise2;

      // Both should return the same run (one created, one cached)
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      expect(result1?.run.friendlyId).toBe(result2?.run.friendlyId);

      // The key assertion: When a retry happens due to RunDuplicateIdempotencyKeyError,
      // the same friendlyId should be used. We expect exactly 2 calls to payloadProcessor
      // (one for each concurrent request), not 3 (which would indicate a new friendlyId on retry)
      // Since the retry returns early from the idempotency cache, payloadProcessor is not called again.
      expect(processedFriendlyIds.length).toBe(2);

      // Verify that we have exactly 2 unique friendlyIds (one per original request)
      const uniqueFriendlyIds = new Set(processedFriendlyIds);
      expect(uniqueFriendlyIds.size).toBe(2);
    }
  );

  containerTest(
    "should reject invalid debounce.delay when no explicit delay is provided",
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
        metadataMaximumSize: 1024 * 1024 * 1,
      });

      // Invalid debounce.delay format (ms not supported)
      await expect(
        triggerTaskService.call({
          taskId: taskIdentifier,
          environment: authenticatedEnvironment,
          body: {
            payload: { test: "test" },
            options: {
              debounce: {
                key: "test-key",
                delay: "300ms", // Invalid - ms not supported
              },
            },
          },
        })
      ).rejects.toThrow("Debounce requires a valid delay duration");
    }
  );

  containerTest(
    "should reject invalid debounce.delay even when explicit delay is valid",
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
        metadataMaximumSize: 1024 * 1024 * 1,
      });

      // Valid explicit delay but invalid debounce.delay
      // This is the bug case: the explicit delay passes validation,
      // but debounce.delay would fail later when rescheduling
      await expect(
        triggerTaskService.call({
          taskId: taskIdentifier,
          environment: authenticatedEnvironment,
          body: {
            payload: { test: "test" },
            options: {
              delay: "5m", // Valid explicit delay
              debounce: {
                key: "test-key",
                delay: "invalid-delay", // Invalid debounce delay
              },
            },
          },
        })
      ).rejects.toThrow("Invalid debounce delay");
    }
  );

  containerTest("should accept valid debounce.delay formats", async ({ prisma, redisOptions }) => {
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
      metadataMaximumSize: 1024 * 1024 * 1,
    });

    // Valid debounce.delay format
    const result = await triggerTaskService.call({
      taskId: taskIdentifier,
      environment: authenticatedEnvironment,
      body: {
        payload: { test: "test" },
        options: {
          debounce: {
            key: "test-key",
            delay: "5s", // Valid format
          },
        },
      },
    });

    expect(result).toBeDefined();
    expect(result?.run.friendlyId).toBeDefined();
  });
});
