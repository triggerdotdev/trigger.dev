import { describe, expect, vi } from "vitest";

// Mock the db prisma client
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

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
import { IOPacket } from "@trigger.dev/core/v3";
import { TaskRun } from "@trigger.dev/database";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import {
  EntitlementValidationParams,
  MaxAttemptsValidationParams,
  ParentRunValidationParams,
  PayloadProcessor,
  TagValidationParams,
  TracedEventSpan,
  TraceEventConcern,
  TriggerRacepoints,
  TriggerRacepointSystem,
  TriggerTaskRequest,
  TriggerTaskValidator,
  ValidationResult,
} from "~/runEngine/types";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import { promiseWithResolvers } from "@trigger.dev/core";
import { setTimeout } from "node:timers/promises";

vi.setConfig({ testTimeout: 60_000 }); // 60 seconds timeout

class MockPayloadProcessor implements PayloadProcessor {
  async process(request: TriggerTaskRequest): Promise<IOPacket> {
    return {
      data: JSON.stringify(request.body.payload),
      dataType: "application/json",
    };
  }
}

class MockTriggerTaskValidator implements TriggerTaskValidator {
  validateTags(params: TagValidationParams): ValidationResult {
    return { ok: true };
  }
  validateEntitlement(params: EntitlementValidationParams): Promise<ValidationResult> {
    return Promise.resolve({ ok: true });
  }
  validateMaxAttempts(params: MaxAttemptsValidationParams): ValidationResult {
    return { ok: true };
  }
  validateParentRun(params: ParentRunValidationParams): ValidationResult {
    return { ok: true };
  }
}

class MockTraceEventConcern implements TraceEventConcern {
  async traceRun<T>(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return await callback(
      {
        traceId: "test",
        spanId: "test",
        traceContext: {},
        traceparent: undefined,
        setAttribute: () => { },
        failWithError: () => { },
        stop: () => { },
      },
      "test"
    );
  }

  async traceIdempotentRun<T>(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    options: {
      existingRun: TaskRun;
      idempotencyKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return await callback(
      {
        traceId: "test",
        spanId: "test",
        traceContext: {},
        traceparent: undefined,
        setAttribute: () => { },
        failWithError: () => { },
        stop: () => { },
      },
      "test"
    );
  }

  async traceDebouncedRun<T>(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    options: {
      existingRun: TaskRun;
      debounceKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T> {
    return await callback(
      {
        traceId: "test",
        spanId: "test",
        traceContext: {},
        traceparent: undefined,
        setAttribute: () => { },
        failWithError: () => { },
        stop: () => { },
      },
      "test"
    );
  }
}

type TriggerRacepoint = { promise: Promise<void>; resolve: (value: void) => void };

class MockTriggerRacepointSystem implements TriggerRacepointSystem {
  private racepoints: Record<string, TriggerRacepoint | undefined> = {};

  async waitForRacepoint({ id }: { racepoint: TriggerRacepoints; id: string }): Promise<void> {
    const racepoint = this.racepoints[id];

    if (racepoint) {
      return racepoint.promise;
    }

    return Promise.resolve();
  }

  registerRacepoint(racepoint: TriggerRacepoints, id: string): TriggerRacepoint {
    const { promise, resolve } = promiseWithResolvers<void>();
    this.racepoints[id] = { promise, resolve };

    return { promise, resolve };
  }
}

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

    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const taskIdentifier = "test-task";

    //create background worker
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

    const run = await prisma.taskRun.findUnique({
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

    await engine.quit();
  });

  containerTest("should handle idempotency keys correctly", async ({ prisma, redisOptions }) => {
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

    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const taskIdentifier = "test-task";

    //create background worker
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
      body: {
        payload: { test: "test" },
        options: {
          idempotencyKey: "test-idempotency-key",
        },
      },
    });

    expect(result).toBeDefined();
    expect(result?.run.friendlyId).toBeDefined();
    expect(result?.run.status).toBe("PENDING");
    expect(result?.isCached).toBe(false);

    const run = await prisma.taskRun.findUnique({
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

    // Now lets try to trigger the same task with the same idempotency key
    const cachedResult = await triggerTaskService.call({
      taskId: taskIdentifier,
      environment: authenticatedEnvironment,
      body: {
        payload: { test: "test" },
        options: {
          idempotencyKey: "test-idempotency-key",
        },
      },
    });

    expect(cachedResult).toBeDefined();
    expect(cachedResult?.run.friendlyId).toBe(result?.run.friendlyId);
    expect(cachedResult?.isCached).toBe(true);

    await engine.quit();
  });

  containerTest(
    "should handle idempotency keys when the engine throws an RunDuplicateIdempotencyKeyError",
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

      const parentTask = "parent-task";

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const taskIdentifier = "test-task";

      //create background worker
      await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, taskIdentifier]);

      const parentRun1 = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_p1",
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

      //dequeue parent and create the attempt
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
          friendlyId: "run_p2",
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
        triggerRacepointSystem,
      });

      const idempotencyKey = "test-idempotency-key";

      const racepoint = triggerRacepointSystem.registerRacepoint("idempotencyKey", idempotencyKey);

      const childTriggerPromise1 = triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
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
          payload: { test: "test" },
          options: {
            idempotencyKey,
            parentRunId: parentRun2.friendlyId,
            resumeParentOnCompletion: true,
          },
        },
      });

      await setTimeout(500);

      // Now we can resolve the racepoint
      racepoint.resolve();

      const result = await childTriggerPromise1;
      const result2 = await childTriggerPromise2;

      expect(result).toBeDefined();
      expect(result?.run.friendlyId).toBeDefined();
      expect(result?.run.status).toBe("PENDING");

      const run = await prisma.taskRun.findUnique({
        where: {
          id: result?.run.id,
        },
      });

      expect(run).toBeDefined();
      expect(run?.friendlyId).toBe(result?.run.friendlyId);
      expect(run?.engine).toBe("V2");
      expect(run?.queuedAt).toBeDefined();
      expect(run?.queue).toBe(`task/${taskIdentifier}`);

      expect(result2).toBeDefined();
      expect(result2?.run.friendlyId).toBe(result?.run.friendlyId);

      const parent1ExecutionData = await engine.getRunExecutionData({ runId: parentRun1.id });
      assertNonNullable(parent1ExecutionData);
      expect(parent1ExecutionData.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      const parent2ExecutionData = await engine.getRunExecutionData({ runId: parentRun2.id });
      assertNonNullable(parent2ExecutionData);
      expect(parent2ExecutionData.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      const parent1RunWaitpoint = await prisma.taskRunWaitpoint.findFirst({
        where: {
          taskRunId: parentRun1.id,
        },
        include: {
          waitpoint: true,
        },
      });

      assertNonNullable(parent1RunWaitpoint);
      expect(parent1RunWaitpoint.waitpoint.type).toBe("RUN");
      expect(parent1RunWaitpoint.waitpoint.completedByTaskRunId).toBe(result?.run.id);

      const parent2RunWaitpoint = await prisma.taskRunWaitpoint.findFirst({
        where: {
          taskRunId: parentRun2.id,
        },
        include: {
          waitpoint: true,
        },
      });

      assertNonNullable(parent2RunWaitpoint);
      expect(parent2RunWaitpoint.waitpoint.type).toBe("RUN");
      expect(parent2RunWaitpoint.waitpoint.completedByTaskRunId).toBe(result2?.run.id);

      await engine.quit();
    }
  );

  containerTest(
    "should resolve queue names correctly when locked to version",
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

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "test-task";

      // Create a background worker with a specific version
      const worker = await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier, {
        preset: "small-1x",
      });

      // Create a specific queue for this worker
      const specificQueue = await prisma.taskQueue.create({
        data: {
          name: "specific-queue",
          friendlyId: "specific-queue",
          projectId: authenticatedEnvironment.projectId,
          runtimeEnvironmentId: authenticatedEnvironment.id,
          workers: {
            connect: {
              id: worker.worker.id,
            },
          },
        },
      });

      // Associate the task with the queue
      await prisma.backgroundWorkerTask.update({
        where: {
          workerId_slug: {
            workerId: worker.worker.id,
            slug: taskIdentifier,
          },
        },
        data: {
          queueId: specificQueue.id,
        },
      });

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

      // Test case 1: Trigger with lockToVersion but no specific queue
      const result1 = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
          options: {
            lockToVersion: worker.worker.version,
          },
        },
      });

      expect(result1).toBeDefined();
      expect(result1?.run.queue).toBe("specific-queue");

      // Test case 2: Trigger with lockToVersion and specific queue
      const result2 = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
          options: {
            lockToVersion: worker.worker.version,
            queue: {
              name: "specific-queue",
            },
          },
        },
      });

      expect(result2).toBeDefined();
      expect(result2?.run.queue).toBe("specific-queue");
      expect(result2?.run.lockedQueueId).toBe(specificQueue.id);

      // Test case 3: Try to use non-existent queue with locked version (should throw)
      await expect(
        triggerTaskService.call({
          taskId: taskIdentifier,
          environment: authenticatedEnvironment,
          body: {
            payload: { test: "test" },
            options: {
              lockToVersion: worker.worker.version,
              queue: {
                name: "non-existent-queue",
              },
            },
          },
        })
      ).rejects.toThrow(
        `Specified queue 'non-existent-queue' not found or not associated with locked version '${worker.worker.version}'`
      );

      // Test case 4: Trigger with a non-existent queue without a locked version
      const result4 = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
          options: {
            queue: {
              name: "non-existent-queue",
            },
          },
        },
      });

      expect(result4).toBeDefined();
      expect(result4?.run.queue).toBe("non-existent-queue");
      expect(result4?.run.status).toBe("PENDING");

      await engine.quit();
    }
  );

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

      const parentTask = "parent-task";
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "test-task";

      // Create background worker
      await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, taskIdentifier]);

      // Create parent runs and start their attempts (required for resumeParentOnCompletion)
      const parentRun1 = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_p1",
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
          friendlyId: "run_p2",
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

      await engine.quit();
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

      await engine.quit();
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

      await engine.quit();
    }
  );

  containerTest(
    "should accept valid debounce.delay formats",
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

      await engine.quit();
    }
  );

  // ─── Mollifier integration ──────────────────────────────────────────────────
  //
  // These tests pin the call-site behaviour of the mollifier hooks inside
  // RunEngineTriggerTaskService.call. They use the optional DI ports
  // (`evaluateGate`, `getMollifierBuffer`) added on the service constructor —
  // production wiring is unchanged (defaults to the live module-level imports).
  // Each test's regression intent lives in its own setup comment.

  class CapturingMollifierBuffer {
    public accepted: Array<{ runId: string; envId: string; orgId: string; payload: string }> = [];
    async accept(input: { runId: string; envId: string; orgId: string; payload: string }) {
      this.accepted.push(input);
      return true;
    }
    async pop() { return null; }
    async ack() {}
    async requeue() {}
    async fail() { return false; }
    async getEntry() { return null; }
    async listEnvs(): Promise<string[]> { return []; }
    async getEntryTtlSeconds(): Promise<number> { return -1; }
    async evaluateTrip() { return { tripped: false, count: 0 }; }
    async close() {}
  }

  containerTest(
    "mollifier · validation throws before the gate is consulted; no buffer write",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: { "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      // Validator that fails on maxAttempts. Any validation throw must abort
      // the call BEFORE the gate runs — otherwise the gate could leak a
      // buffer write for an invalid request.
      class FailingMaxAttemptsValidator extends MockTriggerTaskValidator {
        validateMaxAttempts(): ValidationResult {
          return { ok: false, error: new Error("synthetic max-attempts failure") };
        }
      }

      const buffer = new CapturingMollifierBuffer();
      const evaluateGateSpy = vi.fn(async () => ({ action: "mollify" as const, decision: {
        divert: true as const, reason: "per_env_rate" as const, count: 99, threshold: 1, windowMs: 200, holdMs: 500,
      } }));

      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: new DefaultQueueManager(prisma, engine),
        idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
        validator: new FailingMaxAttemptsValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
        evaluateGate: evaluateGateSpy,
        getMollifierBuffer: () => buffer as never,
      });

      await expect(
        triggerTaskService.call({
          taskId: taskIdentifier,
          environment: authenticatedEnvironment,
          body: { payload: { test: "x" } },
        }),
      ).rejects.toThrow(/synthetic max-attempts failure/);

      // Critical: the gate must NEVER be consulted when validation fails.
      // If this assertion fires, validation has been re-ordered after the
      // mollifier gate — a regression that would let invalid triggers land
      // in the buffer.
      expect(evaluateGateSpy).not.toHaveBeenCalled();
      expect(buffer.accepted).toHaveLength(0);

      await engine.quit();
    },
  );

  containerTest(
    "mollifier · mollify action triggers dual-write (buffer.accept + engine.trigger)",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: { "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      const buffer = new CapturingMollifierBuffer();
      const trippedDecision = {
        divert: true as const,
        reason: "per_env_rate" as const,
        count: 150,
        threshold: 100,
        windowMs: 200,
        holdMs: 500,
      };

      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: new DefaultQueueManager(prisma, engine),
        idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
        evaluateGate: async () => ({ action: "mollify", decision: trippedDecision }),
        getMollifierBuffer: () => buffer as never,
      });

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { hello: "world" } },
      });

      // engine.trigger ran — Postgres has the run
      expect(result).toBeDefined();
      expect(result?.run.friendlyId).toBeDefined();
      const pgRun = await prisma.taskRun.findFirst({ where: { id: result!.run.id } });
      expect(pgRun).not.toBeNull();
      expect(pgRun!.friendlyId).toBe(result!.run.friendlyId);

      // buffer.accept ran — Redis has the audit copy under the same friendlyId
      expect(buffer.accepted).toHaveLength(1);
      expect(buffer.accepted[0]!.runId).toBe(result!.run.friendlyId);
      expect(buffer.accepted[0]!.envId).toBe(authenticatedEnvironment.id);
      expect(buffer.accepted[0]!.orgId).toBe(authenticatedEnvironment.organizationId);

      // payload is the canonical replay shape
      const payload = JSON.parse(buffer.accepted[0]!.payload);
      expect(payload.runFriendlyId).toBe(result!.run.friendlyId);
      expect(payload.taskId).toBe(taskIdentifier);
      expect(payload.envId).toBe(authenticatedEnvironment.id);
      expect(payload.body).toEqual({ payload: { hello: "world" } });

      await engine.quit();
    },
  );

  containerTest(
    "mollifier · pass_through action does NOT call buffer.accept",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: { "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      const buffer = new CapturingMollifierBuffer();
      const getBufferSpy = vi.fn(() => buffer as never);

      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: new DefaultQueueManager(prisma, engine),
        idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
        evaluateGate: async () => ({ action: "pass_through" }),
        getMollifierBuffer: getBufferSpy,
      });

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "x" } },
      });

      expect(result).toBeDefined();
      // Postgres has the run, no buffer side-effects
      expect(buffer.accepted).toHaveLength(0);
      // getMollifierBuffer must not be called either — the call site short-circuits
      // before touching the singleton when the gate says pass_through.
      expect(getBufferSpy).not.toHaveBeenCalled();

      await engine.quit();
    },
  );

  containerTest(
    "mollifier · engine.trigger throwing AFTER buffer.accept leaves an orphan entry (documented behaviour)",
    async ({ prisma, redisOptions }) => {
      // SCENARIO: dual-write where buffer.accept succeeds but engine.trigger
      // throws. The throw propagates to the caller (correct: customer sees
      // the same 4xx as today), and the buffer entry remains as an "orphan"
      // — Phase 1's no-op drainer will pop+ack it on its next poll, so the
      // orphan is bounded (~drainer pollIntervalMs) but observable in the
      // audit trail (mollifier.buffered with no matching TaskRun).
      //
      // Why engine.trigger can throw post-buffer:
      //   - RunDuplicateIdempotencyKeyError (Prisma P2002 on idempotencyKey):
      //     a concurrent non-mollified trigger with the same idempotencyKey
      //     wins the DB UNIQUE constraint between IdempotencyKeyConcern's
      //     pre-check and engine.trigger's INSERT.
      //   - RunOneTimeUseTokenError (Prisma P2002 on oneTimeUseToken).
      //   - Transient Prisma errors (FK constraint, connection drop, etc.).
      //
      // Why we don't "fix" this race in Phase 1:
      //   The customer correctly gets the error. State eventually converges
      //   (drainer pops the orphan). The audit-trail explicitly surfaces
      //   "buffered without TaskRun" entries to operators. A real fix is
      //   Phase 2's responsibility once the buffer becomes the primary write
      //   — at that point we add the mollifier-specific idempotency index.
      //
      // This test pins the current ordering: buffer.accept fires synchronously
      // BEFORE engine.trigger, and engine.trigger failure does NOT roll back
      // the buffer write. Any future change that reverses the order or adds
      // a silent rollback will fail this assertion and force a design
      // decision rather than a silent behaviour change.

      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: { "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      const buffer = new CapturingMollifierBuffer();

      // Force engine.trigger to throw on this single call. We spy AFTER
      // setupBackgroundWorker so the worker setup still uses the real
      // engine.trigger (which has its own engine.trigger-ish calls for
      // worker bootstrap — though in practice setupBackgroundWorker doesn't
      // call trigger).
      const simulatedFailure = new Error("simulated engine.trigger failure post-buffer");
      vi.spyOn(engine, "trigger").mockRejectedValueOnce(simulatedFailure);

      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: new DefaultQueueManager(prisma, engine),
        idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
        evaluateGate: async () => ({
          action: "mollify",
          decision: {
            divert: true,
            reason: "per_env_rate",
            count: 150,
            threshold: 100,
            windowMs: 200,
            holdMs: 500,
          },
        }),
        getMollifierBuffer: () => buffer as never,
      });

      await expect(
        triggerTaskService.call({
          taskId: taskIdentifier,
          environment: authenticatedEnvironment,
          body: { payload: { test: "x" } },
        }),
      ).rejects.toThrow(/simulated engine.trigger failure post-buffer/);

      // The buffer write happened BEFORE engine.trigger threw. The orphan
      // remains; the audit-trail will surface it (mollifier.buffered with
      // no matching TaskRun row). Phase 1's no-op drainer cleans it up.
      expect(buffer.accepted).toHaveLength(1);
      const orphanPayload = JSON.parse(buffer.accepted[0]!.payload);
      expect(orphanPayload.taskId).toBe(taskIdentifier);

      await engine.quit();
    },
  );

  containerTest(
    "mollifier · idempotency-key match short-circuits BEFORE the gate is consulted",
    async ({ prisma, redisOptions }) => {
      // SCENARIO: a trigger arrives with an idempotency key matching an
      // already-created run. `IdempotencyKeyConcern.handleTriggerRequest`
      // (line 236 of triggerTask.server.ts) detects the match BEFORE the
      // mollifier gate runs and returns `{ isCached: true, run }`. The
      // service early-returns. The gate is never consulted, buffer.accept
      // never fires, no orphan entry is created.
      //
      // Regression intent: if IdempotencyKeyConcern were re-ordered to run
      // AFTER evaluateGate, every idempotent retry on a flagged org would
      // produce an orphan buffer entry — the audit-trail invariant ("every
      // buffered runId has a matching TaskRun") would silently start failing
      // for retries. This test pins the current order.

      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: { "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      const idempotencyKeyConcern = new IdempotencyKeyConcern(
        prisma,
        engine,
        new MockTraceEventConcern(),
      );

      // Setup: normal trigger to create the cached run (no mollifier).
      const baseline = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: new DefaultQueueManager(prisma, engine),
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
      });
      const first = await baseline.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "x" }, options: { idempotencyKey: "regression-key-5" } },
      });
      expect(first?.isCached).toBe(false);

      // Action: same idempotency key, with a mollify-stub gate that WOULD
      // create an orphan if reached. The concern must short-circuit first.
      const buffer = new CapturingMollifierBuffer();
      const evaluateGateSpy = vi.fn(async () => ({
        action: "mollify" as const,
        decision: {
          divert: true as const,
          reason: "per_env_rate" as const,
          count: 150,
          threshold: 100,
          windowMs: 200,
          holdMs: 500,
        },
      }));

      const mollifierService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: new DefaultQueueManager(prisma, engine),
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
        evaluateGate: evaluateGateSpy,
        getMollifierBuffer: () => buffer as never,
      });

      const cached = await mollifierService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "x" }, options: { idempotencyKey: "regression-key-5" } },
      });

      // Customer sees the cached run, isCached=true
      expect(cached).toBeDefined();
      expect(cached?.isCached).toBe(true);
      expect(cached?.run.friendlyId).toBe(first?.run.friendlyId);

      // Critical: the gate must NEVER be consulted on a cached-idempotency replay.
      expect(evaluateGateSpy).not.toHaveBeenCalled();
      expect(buffer.accepted).toHaveLength(0);

      await engine.quit();
    },
  );

  containerTest(
    "mollifier · debounce match produces an orphan buffer entry (documented behaviour)",
    async ({ prisma, redisOptions }) => {
      // SCENARIO: a trigger with a debounce key arrives while a matching
      // debounced run already exists. `debounceSystem.handleDebounce` runs
      // INSIDE `engine.trigger` (line ~514 of run-engine/src/engine/index.ts),
      // AFTER buffer.accept has already written the new friendlyId. The
      // service correctly returns the existing run id to the customer, but
      // the buffer is left with an orphan entry for the new friendlyId.
      //
      // Why this is acceptable in Phase 1:
      //   - Customer-facing behaviour is unchanged from today: they receive
      //     the existing run id, same as the non-mollified path.
      //   - The orphan is bounded — the drainer's no-op-ack handler pops
      //     and acks it on its next poll.
      //   - The audit-trail surfaces it: a `mollifier.buffered` log line
      //     with `runId` that has no matching TaskRun in Postgres.
      //
      // Why Phase 2 cares:
      //   - When the buffer becomes the primary write path, debounce can
      //     no longer be allowed to run AFTER buffer.accept. The drainer's
      //     engine.trigger replay would observe "existing" and skip the
      //     persist — the customer's synthesised 200 (with the new
      //     friendlyId) would never get a TaskRun, and the audit-trail
      //     divergence becomes a real data-loss bug.
      //   - Phase 2 must lift `handleDebounce` into the call site BEFORE
      //     buffer.accept:
      //       1. handleDebounce → if existing, return existing run; do NOT
      //          touch the buffer.
      //       2. Otherwise, accept with `claimId` threaded into the
      //          canonical payload so the drainer's replay can
      //          `registerDebouncedRun` after persisting.
      //
      // This test pins the current ordering. A future change that "fixes"
      // it by lifting handleDebounce upfront will fail the orphan
      // assertion below and force an explicit choice (update the test,
      // remove this scenario, or stage the lift behind a flag).

      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: { "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 } },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      const idempotencyKeyConcern = new IdempotencyKeyConcern(
        prisma,
        engine,
        new MockTraceEventConcern(),
      );

      // Setup: trigger with debounce — creates the existing run + Redis claim.
      const baseline = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: new DefaultQueueManager(prisma, engine),
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
      });
      const first = await baseline.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "x" },
          options: { debounce: { key: "regression-debounce-6", delay: "30s" } },
        },
      });
      expect(first?.run.friendlyId).toBeDefined();

      // Action: same debounce key, mollify-stub gate.
      const buffer = new CapturingMollifierBuffer();
      const mollifierService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: new DefaultQueueManager(prisma, engine),
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
        evaluateGate: async () => ({
          action: "mollify",
          decision: {
            divert: true,
            reason: "per_env_rate",
            count: 150,
            threshold: 100,
            windowMs: 200,
            holdMs: 500,
          },
        }),
        getMollifierBuffer: () => buffer as never,
      });

      const debounced = await mollifierService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "x" },
          options: { debounce: { key: "regression-debounce-6", delay: "30s" } },
        },
      });

      // Customer-facing behaviour: the existing run is returned (correct).
      expect(debounced).toBeDefined();
      expect(debounced?.run.friendlyId).toBe(first?.run.friendlyId);

      // Orphan: buffer.accept fired with the new friendlyId we generated
      // upfront, and that friendlyId has no matching TaskRun in Postgres
      // because engine.trigger returned the existing run via debounce.
      expect(buffer.accepted).toHaveLength(1);
      expect(buffer.accepted[0]!.runId).not.toBe(first?.run.friendlyId);
      const orphanFriendlyId = buffer.accepted[0]!.runId;
      const orphanRow = await prisma.taskRun.findFirst({
        where: { friendlyId: orphanFriendlyId },
      });
      expect(orphanRow).toBeNull();

      await engine.quit();
    },
  );
});
