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
import { Redis } from "ioredis";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import { RedisTaskMetadataCache } from "~/services/taskMetadataCache.server";
import { ChangeCurrentDeploymentService } from "~/v3/services/changeCurrentDeployment.server";
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
});

describe("DefaultQueueManager task metadata cache", () => {
  containerTest(
    "warm cache returns metadata without falling through to PG",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "cached-task";
      const setup = await setupBackgroundWorker(engine, environment, taskIdentifier);

      const redis = new Redis(redisOptions);
      const cache = new RedisTaskMetadataCache({ redis });

      // Pre-populate cache with AGENT triggerSource; DB row has the default STANDARD.
      // If the read path hits the cache, the resulting TaskRun.taskKind reflects the
      // cached value. If it falls through to PG, it reflects STANDARD.
      await cache.populateByCurrentWorker(environment.id, setup.worker.id, [
        {
          slug: taskIdentifier,
          ttl: null,
          triggerSource: "AGENT",
          queueId: null,
          queueName: `task/${taskIdentifier}`,
        },
      ]);

      const queuesManager = new DefaultQueueManager(prisma, engine, undefined, cache);
      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
      });

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" } },
      });

      assertNonNullable(result);
      expect(result.run.taskIdentifier).toBe(taskIdentifier);
      expect((result.run.annotations as { taskKind?: string } | null)?.taskKind).toBe("AGENT");

      await redis.quit();
      await engine.quit();
    }
  );

  containerTest(
    "cache miss falls through to PG and back-fills the cache",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "miss-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const redis = new Redis(redisOptions);
      const cache = new RedisTaskMetadataCache({ redis });

      // Cache starts empty. Sanity-check both keyspaces.
      expect(await cache.getCurrent(environment.id, taskIdentifier)).toBeNull();

      const queuesManager = new DefaultQueueManager(prisma, engine, undefined, cache);
      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
      });

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "x" } },
      });

      assertNonNullable(result);
      expect((result.run.annotations as { taskKind?: string } | null)?.taskKind).toBe("STANDARD");

      // Back-fill is fire-and-forget; poll with a bounded timeout to avoid CI flakes.
      let backfilled = await cache.getCurrent(environment.id, taskIdentifier);
      for (let i = 0; i < 40 && !backfilled; i++) {
        await setTimeout(25);
        backfilled = await cache.getCurrent(environment.id, taskIdentifier);
      }
      expect(backfilled).not.toBeNull();
      expect(backfilled?.triggerSource).toBe("STANDARD");
      expect(backfilled?.queueName).toBe(`task/${taskIdentifier}`);

      await redis.quit();
      await engine.quit();
    }
  );

  containerTest(
    "queue-override + ttl path returns taskKind from cache without a BWT lookup",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "override-task";
      const setup = await setupBackgroundWorker(engine, environment, taskIdentifier);

      const redis = new Redis(redisOptions);
      const cache = new RedisTaskMetadataCache({ redis });

      // Cache says AGENT; DB row says STANDARD. Caller provides both a queue
      // override and an explicit TTL — the hot path the PR regressed.
      await cache.populateByCurrentWorker(environment.id, setup.worker.id, [
        {
          slug: taskIdentifier,
          ttl: null,
          triggerSource: "AGENT",
          queueId: null,
          queueName: `task/${taskIdentifier}`,
        },
      ]);

      const queuesManager = new DefaultQueueManager(prisma, engine, undefined, cache);
      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
      });

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment,
        body: {
          payload: { test: "x" },
          options: {
            queue: { name: "caller-queue" },
            ttl: "5m",
          },
        },
      });

      assertNonNullable(result);
      expect(result.run.queue).toBe("caller-queue");
      expect((result.run.annotations as { taskKind?: string } | null)?.taskKind).toBe("AGENT");

      await redis.quit();
      await engine.quit();
    }
  );

  containerTest(
    "locked-version trigger reads from by-worker keyspace, not env keyspace",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "keyspace-task";
      const worker = await setupBackgroundWorker(engine, environment, taskIdentifier);

      const redis = new Redis(redisOptions);
      const cache = new RedisTaskMetadataCache({ redis });

      // Populate the two keyspaces with conflicting triggerSource values so we
      // can tell which keyspace the read used. The real worker's by-worker
      // hash gets AGENT; the env hash gets SCHEDULED (seeded via a throwaway
      // worker id since `populateByCurrentWorker` writes both keyspaces and
      // we want the real worker's by-worker hash untouched).
      await cache.populateByWorker(worker.worker.id, [
        {
          slug: taskIdentifier,
          ttl: null,
          triggerSource: "AGENT",
          queueId: null,
          queueName: `task/${taskIdentifier}`,
        },
      ]);
      await cache.populateByCurrentWorker(environment.id, "dummy-worker-for-env-seed", [
        {
          slug: taskIdentifier,
          ttl: null,
          triggerSource: "SCHEDULED",
          queueId: null,
          queueName: `task/${taskIdentifier}`,
        },
      ]);

      const queuesManager = new DefaultQueueManager(prisma, engine, undefined, cache);
      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern: new IdempotencyKeyConcern(prisma, engine, new MockTraceEventConcern()),
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024,
      });

      // Locked → by-worker keyspace → AGENT
      const locked = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment,
        body: {
          payload: { test: "x" },
          options: { lockToVersion: worker.worker.version },
        },
      });
      assertNonNullable(locked);
      expect((locked.run.annotations as { taskKind?: string } | null)?.taskKind).toBe("AGENT");

      // Not locked → env keyspace → SCHEDULED
      const current = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment,
        body: { payload: { test: "y" } },
      });
      assertNonNullable(current);
      expect((current.run.annotations as { taskKind?: string } | null)?.taskKind).toBe("SCHEDULED");

      await redis.quit();
      await engine.quit();
    }
  );

  containerTest(
    "ChangeCurrentDeploymentService promotes the env cache to the new worker",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
        queue: { redis: redisOptions },
        runLock: { redis: redisOptions },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": { name: "small-1x", cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
          },
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "promotion-task";

      // Worker A → setupBackgroundWorker auto-creates a deployment + promotes it.
      const workerA = await setupBackgroundWorker(engine, environment, taskIdentifier);
      // Worker B → setupBackgroundWorker overrides the promotion to point at B.
      const workerB = await setupBackgroundWorker(engine, environment, taskIdentifier);

      assertNonNullable(workerA.deployment);
      assertNonNullable(workerB.deployment);

      const redis = new Redis(redisOptions);
      const cache = new RedisTaskMetadataCache({ redis });

      // Pre-clear any pre-existing cache state so the assertions below prove
      // the rollback service did the write — not some other path. The test
      // helpers don't currently populate the cache, but pre-clearing keeps the
      // test bulletproof against future helper changes.
      await redis.del(`task-meta:by-worker:${workerA.worker.id}`);
      await redis.del(`task-meta:env:${environment.id}`);
      expect(await cache.getByWorker(workerA.worker.id, taskIdentifier)).toBeNull();
      expect(await cache.getCurrent(environment.id, taskIdentifier)).toBeNull();

      // Manually rollback to A to exercise the cache-write side effect.
      const service = new ChangeCurrentDeploymentService(prisma, undefined, cache);
      await service.call(workerA.deployment, "rollback", true /* disableVersionCheck */);

      // Both keyspaces should now reflect workerA.
      const entry = await cache.getCurrent(environment.id, taskIdentifier);
      expect(entry).not.toBeNull();
      const byWorkerEntry = await cache.getByWorker(workerA.worker.id, taskIdentifier);
      expect(byWorkerEntry).not.toBeNull();
      expect(byWorkerEntry?.queueName).toBe(`task/${taskIdentifier}`);

      await redis.quit();
      await engine.quit();
    }
  );
});
