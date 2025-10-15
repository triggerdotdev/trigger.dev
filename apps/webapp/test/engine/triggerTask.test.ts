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
import { IOPacket, TaskRunEnvironmentVariablesConfig } from "@trigger.dev/core/v3";
import { TaskRun } from "@trigger.dev/database";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import {
  EntitlementValidationParams,
  MaxAttemptsValidationParams,
  ParentRunValidationParams,
  PayloadProcessor,
  RunNumberIncrementer,
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
import { DefaultEnvironmentVariablesProcessor } from "~/runEngine/concerns/environmentVariablesProcessor.server";

vi.setConfig({ testTimeout: 30_000 }); // 30 seconds timeout

class MockRunNumberIncrementer implements RunNumberIncrementer {
  async incrementRunNumber<T>(
    request: TriggerTaskRequest,
    callback: (num: number) => Promise<T>
  ): Promise<T | undefined> {
    return await callback(1);
  }
}

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
        setAttribute: () => {},
        failWithError: () => {},
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
        setAttribute: () => {},
        failWithError: () => {},
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
      runNumberIncrementer: new MockRunNumberIncrementer(),
      payloadProcessor: new MockPayloadProcessor(),
      queueConcern: queuesManager,
      idempotencyKeyConcern,
      validator: new MockTriggerTaskValidator(),
      traceEventConcern: new MockTraceEventConcern(),
      tracer: trace.getTracer("test", "0.0.0"),
      metadataMaximumSize: 1024 * 1024 * 1, // 1MB
      environmentVariablesProcessor: new DefaultEnvironmentVariablesProcessor(
        "7d046af878577f9c85295ce92324ec79"
      ),
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
    expect(run?.environmentVariablesConfig).toBeNull();

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
      runNumberIncrementer: new MockRunNumberIncrementer(),
      payloadProcessor: new MockPayloadProcessor(),
      queueConcern: queuesManager,
      idempotencyKeyConcern,
      validator: new MockTriggerTaskValidator(),
      traceEventConcern: new MockTraceEventConcern(),
      tracer: trace.getTracer("test", "0.0.0"),
      metadataMaximumSize: 1024 * 1024 * 1, // 1MB
      environmentVariablesProcessor: new DefaultEnvironmentVariablesProcessor(
        "7d046af878577f9c85295ce92324ec79"
      ),
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
    expect(run?.environmentVariablesConfig).toBeNull();

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
        runNumberIncrementer: new MockRunNumberIncrementer(),
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024 * 1, // 1MB
        triggerRacepointSystem,
        environmentVariablesProcessor: new DefaultEnvironmentVariablesProcessor(
          "7d046af878577f9c85295ce92324ec79"
        ),
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
        runNumberIncrementer: new MockRunNumberIncrementer(),
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024 * 1, // 1MB
        environmentVariablesProcessor: new DefaultEnvironmentVariablesProcessor(
          "7d046af878577f9c85295ce92324ec79"
        ),
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
    "should process environment variables correctly",
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
        runNumberIncrementer: new MockRunNumberIncrementer(),
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        tracer: trace.getTracer("test", "0.0.0"),
        metadataMaximumSize: 1024 * 1024 * 1, // 1MB
        environmentVariablesProcessor: new DefaultEnvironmentVariablesProcessor(
          "7d046af878577f9c85295ce92324ec79"
        ),
      });

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
          options: {
            env: {
              variables: {
                TEST_VARIABLE: "test-value",
              },
              whitelist: ["OPENAI_API_KEY"],
            },
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
      expect(run?.environmentVariablesConfig).toBeDefined();

      const config = TaskRunEnvironmentVariablesConfig.safeParse(run?.environmentVariablesConfig);
      expect(config.success).toBe(true);
      expect(config.data?.variables).toBeDefined();
      expect(config.data?.variables?.TEST_VARIABLE).toBeDefined();
      expect(config.data?.whitelist).toBeDefined();
      expect(config.data?.whitelist?.length).toBe(1);
      expect(config.data?.whitelist?.[0]).toBe("OPENAI_API_KEY");

      await engine.quit();
    }
  );
});
