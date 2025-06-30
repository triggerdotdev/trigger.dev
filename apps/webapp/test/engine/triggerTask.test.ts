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
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { IOPacket } from "@trigger.dev/core/v3";
import { TaskRun } from "@trigger.dev/database";
import { IdempotencyKeyConcern } from "~/runEngine/concerns/idempotencyKeys.server";
import { DefaultQueueManager } from "~/runEngine/concerns/queues.server";
import { DefaultRunChainStateManager } from "~/runEngine/concerns/runChainStates.server";
import {
  EntitlementValidationParams,
  MaxAttemptsValidationParams,
  ParentRunValidationParams,
  PayloadProcessor,
  RunNumberIncrementer,
  TagValidationParams,
  TracedEventSpan,
  TraceEventConcern,
  TriggerTaskRequest,
  TriggerTaskValidator,
  ValidationResult,
} from "~/runEngine/types";
import { RunEngineTriggerTaskService } from "../../app/runEngine/services/triggerTask.server";
import { setTimeout } from "node:timers/promises";

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
    callback: (span: TracedEventSpan) => Promise<T>
  ): Promise<T> {
    return await callback({
      traceId: "test",
      spanId: "test",
      traceContext: {},
      traceparent: undefined,
      setAttribute: () => {},
      failWithError: () => {},
    });
  }

  async traceIdempotentRun<T>(
    request: TriggerTaskRequest,
    options: {
      existingRun: TaskRun;
      idempotencyKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan) => Promise<T>
  ): Promise<T> {
    return await callback({
      traceId: "test",
      spanId: "test",
      traceContext: {},
      traceparent: undefined,
      setAttribute: () => {},
      failWithError: () => {},
    });
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

    const runChainStateManager = new DefaultRunChainStateManager(prisma, true);

    const triggerTaskService = new RunEngineTriggerTaskService({
      engine,
      prisma,
      runNumberIncrementer: new MockRunNumberIncrementer(),
      payloadProcessor: new MockPayloadProcessor(),
      queueConcern: queuesManager,
      idempotencyKeyConcern,
      validator: new MockTriggerTaskValidator(),
      traceEventConcern: new MockTraceEventConcern(),
      runChainStateManager,
      tracer: trace.getTracer("test", "0.0.0"),
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

    const runChainStateManager = new DefaultRunChainStateManager(prisma, true);

    const triggerTaskService = new RunEngineTriggerTaskService({
      engine,
      prisma,
      runNumberIncrementer: new MockRunNumberIncrementer(),
      payloadProcessor: new MockPayloadProcessor(),
      queueConcern: queuesManager,
      idempotencyKeyConcern,
      validator: new MockTriggerTaskValidator(),
      traceEventConcern: new MockTraceEventConcern(),
      runChainStateManager,
      tracer: trace.getTracer("test", "0.0.0"),
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

      const runChainStateManager = new DefaultRunChainStateManager(prisma, true);

      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        runNumberIncrementer: new MockRunNumberIncrementer(),
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        runChainStateManager,
        tracer: trace.getTracer("test", "0.0.0"),
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
    "should handle run chains correctly when release concurrency is enabled",
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
          masterQueueConsumersDisabled: true,
          processWorkerQueueDebounceMs: 100,
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
      const { worker } = await setupBackgroundWorker(
        engine,
        authenticatedEnvironment,
        taskIdentifier,
        undefined,
        undefined,
        {
          releaseConcurrencyOnWaitpoint: false,
          concurrencyLimit: 2,
        }
      );

      const queuesManager = new DefaultQueueManager(prisma, engine);

      const idempotencyKeyConcern = new IdempotencyKeyConcern(
        prisma,
        engine,
        new MockTraceEventConcern()
      );

      const runChainStateManager = new DefaultRunChainStateManager(prisma, true);

      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        runNumberIncrementer: new MockRunNumberIncrementer(),
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        runChainStateManager,
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const result = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: { payload: { test: "test" } },
      });

      console.log(result);

      expect(result).toBeDefined();
      expect(result?.run.friendlyId).toBeDefined();
      expect(result?.run.status).toBe("PENDING");
      expect(result?.isCached).toBe(false);

      // Lets make sure the task is in the queue
      const queueLength = await engine.runQueue.lengthOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );
      expect(queueLength).toBe(1);

      await setTimeout(500);

      // Now we need to dequeue the run so so we can trigger a subtask
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: result?.run.workerQueue!,
      });

      expect(dequeued.length).toBe(1);
      expect(dequeued[0].run.id).toBe(result?.run.id);

      // Now, lets trigger a subtask, with the same task identifier and queue
      const subtaskResult = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
          options: {
            parentRunId: result?.run.friendlyId,
            resumeParentOnCompletion: true,
            lockToVersion: worker.version,
          },
        },
      });

      expect(subtaskResult).toBeDefined();
      expect(subtaskResult?.run.status).toBe("PENDING");
      expect(subtaskResult?.run.parentTaskRunId).toBe(result?.run.id);
      expect(subtaskResult?.run.lockedQueueId).toBeDefined();
      expect(subtaskResult?.run.runChainState).toEqual({
        concurrency: {
          queues: [
            { id: subtaskResult?.run.lockedQueueId, name: subtaskResult?.run.queue, holding: 1 },
          ],
          environment: 0,
        },
      });

      await setTimeout(500);

      // Okay, now lets dequeue the subtask
      const dequeuedSubtask = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: subtaskResult?.run.workerQueue!,
      });

      expect(dequeuedSubtask.length).toBe(1);
      expect(dequeuedSubtask[0].run.id).toBe(subtaskResult?.run.id);

      // Now, when we trigger the subtask, it should raise a deadlock error
      await expect(
        triggerTaskService.call({
          taskId: taskIdentifier,
          environment: authenticatedEnvironment,
          body: {
            payload: { test: "test" },
            options: {
              parentRunId: subtaskResult?.run.friendlyId,
              resumeParentOnCompletion: true,
              lockToVersion: worker.version,
            },
          },
        })
      ).rejects.toThrow("Deadlock detected");

      await engine.quit();
    }
  );

  containerTest(
    "should handle run chains with multiple queues correctly",
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
          masterQueueConsumersDisabled: true,
          processWorkerQueueDebounceMs: 100,
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
      const taskIdentifier1 = "test-task-1";
      const taskIdentifier2 = "test-task-2";

      // Create a background worker
      const { worker } = await setupBackgroundWorker(
        engine,
        authenticatedEnvironment,
        [taskIdentifier1, taskIdentifier2],
        undefined,
        undefined,
        {
          releaseConcurrencyOnWaitpoint: false,
          concurrencyLimit: 2,
        }
      );

      const queuesManager = new DefaultQueueManager(prisma, engine);
      const idempotencyKeyConcern = new IdempotencyKeyConcern(
        prisma,
        engine,
        new MockTraceEventConcern()
      );
      const runChainStateManager = new DefaultRunChainStateManager(prisma, true);

      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        runNumberIncrementer: new MockRunNumberIncrementer(),
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        runChainStateManager,
        tracer: trace.getTracer("test", "0.0.0"),
      });

      // Trigger parent run on queue1
      const parentResult = await triggerTaskService.call({
        taskId: taskIdentifier1,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
          options: {
            lockToVersion: worker.version,
          },
        },
      });

      expect(parentResult).toBeDefined();
      expect(parentResult?.run.queue).toBe(`task/${taskIdentifier1}`);
      expect(parentResult?.run.lockedQueueId).toBeDefined();

      await setTimeout(500);

      // Dequeue the parent run to simulate it running
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: parentResult?.run.workerQueue!,
      });

      expect(dequeued.length).toBe(1);
      expect(dequeued[0].run.id).toBe(parentResult?.run.id);

      // Now trigger a child run on queue2
      const childResult = await triggerTaskService.call({
        taskId: taskIdentifier2,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
          options: {
            parentRunId: parentResult?.run.friendlyId,
            resumeParentOnCompletion: true,
            lockToVersion: worker.version,
          },
        },
      });

      expect(childResult).toBeDefined();
      expect(childResult?.run.queue).toBe(`task/${taskIdentifier2}`);
      expect(childResult?.run.lockedQueueId).toBeDefined();
      expect(childResult?.run.parentTaskRunId).toBe(parentResult?.run.id);

      // Verify the run chain state
      expect(childResult?.run.runChainState).toEqual({
        concurrency: {
          queues: [
            { id: parentResult?.run.lockedQueueId, name: parentResult?.run.queue, holding: 1 },
          ],
          environment: 0,
        },
      });

      // Now lets trigger task 1 again, and it should be able to run
      const childResult2 = await triggerTaskService.call({
        taskId: taskIdentifier1,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
          options: {
            parentRunId: childResult?.run.friendlyId,
            resumeParentOnCompletion: true,
            lockToVersion: worker.version,
          },
        },
      });

      expect(childResult2).toBeDefined();
      expect(childResult2?.run.status).toBe("PENDING");
      expect(childResult2?.run.parentTaskRunId).toBe(childResult?.run.id);
      expect(childResult2?.run.lockedQueueId).toBeDefined();
      expect(childResult2?.run.runChainState).toMatchObject({
        concurrency: {
          queues: [
            { id: parentResult?.run.lockedQueueId, name: parentResult?.run.queue, holding: 1 },
            { id: childResult?.run.lockedQueueId, name: childResult?.run.queue, holding: 1 },
          ],
          environment: 0,
        },
      });

      // Now lets trigger task 2 again, and it should be able to run
      const childResult3 = await triggerTaskService.call({
        taskId: taskIdentifier2,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
          options: {
            parentRunId: childResult2?.run.friendlyId,
            resumeParentOnCompletion: true,
            lockToVersion: worker.version,
          },
        },
      });

      expect(childResult3).toBeDefined();
      expect(childResult3?.run.status).toBe("PENDING");
      expect(childResult3?.run.parentTaskRunId).toBe(childResult2?.run.id);
      expect(childResult3?.run.lockedQueueId).toBeDefined();
      expect(childResult3?.run.runChainState).toMatchObject({
        concurrency: {
          queues: [
            { id: childResult?.run.lockedQueueId, name: childResult?.run.queue, holding: 1 },
            { id: parentResult?.run.lockedQueueId, name: parentResult?.run.queue, holding: 2 },
          ],
          environment: 0,
        },
      });

      // Now lets trigger task 1 again, and it should deadlock
      await expect(
        triggerTaskService.call({
          taskId: taskIdentifier1,
          environment: authenticatedEnvironment,
          body: {
            payload: { test: "test" },
            options: {
              parentRunId: childResult3?.run.friendlyId,
              resumeParentOnCompletion: true,
              lockToVersion: worker.version,
            },
          },
        })
      ).rejects.toThrow("Deadlock detected");

      await engine.quit();
    }
  );

  containerTest(
    "should handle run chains with explicit releaseConcurrency option",
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
      const taskIdentifier1 = "test-task-1";
      const taskIdentifier2 = "test-task-2";

      // Create a background worker
      const { worker } = await setupBackgroundWorker(
        engine,
        authenticatedEnvironment,
        [taskIdentifier1, taskIdentifier2],
        undefined,
        undefined,
        {
          releaseConcurrencyOnWaitpoint: false,
          concurrencyLimit: 2,
        }
      );

      const queuesManager = new DefaultQueueManager(prisma, engine);
      const idempotencyKeyConcern = new IdempotencyKeyConcern(
        prisma,
        engine,
        new MockTraceEventConcern()
      );
      const runChainStateManager = new DefaultRunChainStateManager(prisma, true);

      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        runNumberIncrementer: new MockRunNumberIncrementer(),
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        runChainStateManager,
        tracer: trace.getTracer("test", "0.0.0"),
      });

      // Trigger parent run on queue1
      const parentResult = await triggerTaskService.call({
        taskId: taskIdentifier1,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
          options: {
            lockToVersion: worker.version,
          },
        },
      });

      expect(parentResult).toBeDefined();
      expect(parentResult?.run.queue).toBe(`task/${taskIdentifier1}`);
      expect(parentResult?.run.lockedQueueId).toBeDefined();

      await setTimeout(500);

      // Dequeue the parent run to simulate it running
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: parentResult?.run.workerQueue!,
      });

      expect(dequeued.length).toBe(1);
      expect(dequeued[0].run.id).toBe(parentResult?.run.id);

      // Now trigger a child run on queue2
      const childResult = await triggerTaskService.call({
        taskId: taskIdentifier2,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
          options: {
            parentRunId: parentResult?.run.friendlyId,
            resumeParentOnCompletion: true,
            lockToVersion: worker.version,
            releaseConcurrency: true,
          },
        },
      });

      expect(childResult).toBeDefined();
      expect(childResult?.run.queue).toBe(`task/${taskIdentifier2}`);
      expect(childResult?.run.lockedQueueId).toBeDefined();
      expect(childResult?.run.parentTaskRunId).toBe(parentResult?.run.id);

      // Verify the run chain state
      expect(childResult?.run.runChainState).toEqual({
        concurrency: {
          queues: [
            { id: parentResult?.run.lockedQueueId, name: parentResult?.run.queue, holding: 0 },
          ],
          environment: 0,
        },
      });

      await engine.quit();
    }
  );

  containerTest(
    "should handle run chains when release concurrency is disabled",
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
          masterQueueConsumersDisabled: true,
          processWorkerQueueDebounceMs: 100,
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
      const taskIdentifier1 = "test-task-1";
      const taskIdentifier2 = "test-task-2";

      // Create a background worker
      const { worker } = await setupBackgroundWorker(
        engine,
        authenticatedEnvironment,
        [taskIdentifier1, taskIdentifier2],
        undefined,
        undefined,
        {
          releaseConcurrencyOnWaitpoint: true,
          concurrencyLimit: 2,
        }
      );

      const queuesManager = new DefaultQueueManager(prisma, engine);
      const idempotencyKeyConcern = new IdempotencyKeyConcern(
        prisma,
        engine,
        new MockTraceEventConcern()
      );
      const runChainStateManager = new DefaultRunChainStateManager(prisma, false);

      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        runNumberIncrementer: new MockRunNumberIncrementer(),
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        runChainStateManager,
        tracer: trace.getTracer("test", "0.0.0"),
      });

      // Trigger parent run on queue1
      const parentResult = await triggerTaskService.call({
        taskId: taskIdentifier1,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
          options: {
            lockToVersion: worker.version,
          },
        },
      });

      expect(parentResult).toBeDefined();
      expect(parentResult?.run.queue).toBe(`task/${taskIdentifier1}`);
      expect(parentResult?.run.lockedQueueId).toBeDefined();

      await setTimeout(500);

      // Dequeue the parent run to simulate it running
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: parentResult?.run.workerQueue!,
      });

      expect(dequeued.length).toBe(1);
      expect(dequeued[0].run.id).toBe(parentResult?.run.id);

      // Now trigger a child run on queue2
      const childResult = await triggerTaskService.call({
        taskId: taskIdentifier2,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
          options: {
            parentRunId: parentResult?.run.friendlyId,
            resumeParentOnCompletion: true,
            lockToVersion: worker.version,
          },
        },
      });

      expect(childResult).toBeDefined();
      expect(childResult?.run.queue).toBe(`task/${taskIdentifier2}`);
      expect(childResult?.run.lockedQueueId).toBeDefined();
      expect(childResult?.run.parentTaskRunId).toBe(parentResult?.run.id);

      // Verify the run chain state
      expect(childResult?.run.runChainState).toEqual({
        concurrency: {
          queues: [
            { id: parentResult?.run.lockedQueueId, name: parentResult?.run.queue, holding: 1 },
          ],
          environment: 1,
        },
      });

      await engine.quit();
    }
  );

  containerTest(
    "should handle run chains correctly when the parent run queue doesn't have a concurrency limit",
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
          masterQueueConsumersDisabled: true,
          processWorkerQueueDebounceMs: 100,
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
      const { worker } = await setupBackgroundWorker(
        engine,
        authenticatedEnvironment,
        taskIdentifier,
        undefined,
        undefined,
        {
          releaseConcurrencyOnWaitpoint: false,
          concurrencyLimit: null,
        }
      );

      const queuesManager = new DefaultQueueManager(prisma, engine);

      const idempotencyKeyConcern = new IdempotencyKeyConcern(
        prisma,
        engine,
        new MockTraceEventConcern()
      );

      const runChainStateManager = new DefaultRunChainStateManager(prisma, true);

      const triggerTaskService = new RunEngineTriggerTaskService({
        engine,
        prisma,
        runNumberIncrementer: new MockRunNumberIncrementer(),
        payloadProcessor: new MockPayloadProcessor(),
        queueConcern: queuesManager,
        idempotencyKeyConcern,
        validator: new MockTriggerTaskValidator(),
        traceEventConcern: new MockTraceEventConcern(),
        runChainStateManager,
        tracer: trace.getTracer("test", "0.0.0"),
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

      // Lets make sure the task is in the queue
      const queueLength = await engine.runQueue.lengthOfQueue(
        authenticatedEnvironment,
        `task/${taskIdentifier}`
      );
      expect(queueLength).toBe(1);

      await setTimeout(500);

      // Now we need to dequeue the run so so we can trigger a subtask
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: result?.run.workerQueue!,
      });

      expect(dequeued.length).toBe(1);
      expect(dequeued[0].run.id).toBe(result?.run.id);

      // Now, lets trigger a subtask, with the same task identifier and queue
      const subtaskResult = await triggerTaskService.call({
        taskId: taskIdentifier,
        environment: authenticatedEnvironment,
        body: {
          payload: { test: "test" },
          options: {
            parentRunId: result?.run.friendlyId,
            resumeParentOnCompletion: true,
            lockToVersion: worker.version,
          },
        },
      });

      expect(subtaskResult).toBeDefined();
      expect(subtaskResult?.run.status).toBe("PENDING");
      expect(subtaskResult?.run.parentTaskRunId).toBe(result?.run.id);
      expect(subtaskResult?.run.lockedQueueId).toBeDefined();
      expect(subtaskResult?.run.runChainState).toEqual({
        concurrency: {
          queues: [
            { id: subtaskResult?.run.lockedQueueId, name: subtaskResult?.run.queue, holding: 0 },
          ],
          environment: 0,
        },
      });

      await setTimeout(500);

      // Okay, now lets dequeue the subtask
      const dequeuedSubtask = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: subtaskResult?.run.workerQueue!,
      });

      expect(dequeuedSubtask.length).toBe(1);
      expect(dequeuedSubtask[0].run.id).toBe(subtaskResult?.run.id);

      // Now, when we trigger the subtask, it should NOT raise a deadlock error
      await expect(
        triggerTaskService.call({
          taskId: taskIdentifier,
          environment: authenticatedEnvironment,
          body: {
            payload: { test: "test" },
            options: {
              parentRunId: subtaskResult?.run.friendlyId,
              resumeParentOnCompletion: true,
              lockToVersion: worker.version,
            },
          },
        })
      ).resolves.toBeDefined();

      await engine.quit();
    }
  );
});
