import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { createRedisClient } from "@internal/redis";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine debounce", () => {
  containerTest("Basic debounce: first trigger creates run", async ({ prisma, redisOptions }) => {
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
        baseCostInCents: 0.0001,
      },
      debounce: {
        maxDebounceDurationMs: 60_000, // 1 minute max debounce
      },
      tracer: trace.getTracer("test", "0.0.0"),
    });

    try {
      const taskIdentifier = "test-task";

      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      // Trigger with debounce
      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_deb1",
          environment: authenticatedEnvironment,
          taskIdentifier,
          payload: '{"data": "first"}',
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          workerQueue: "main",
          queue: "task/test-task",
          isTest: false,
          tags: [],
          delayUntil: new Date(Date.now() + 5000),
          debounce: {
            key: "user-123",
            delay: "5s",
          },
        },
        prisma
      );

      expect(run.friendlyId).toBe("run_deb1");
      expect(run.status).toBe("DELAYED");

      // Verify debounce is stored in the run
      const dbRun = await prisma.taskRun.findFirst({
        where: { id: run.id },
      });
      assertNonNullable(dbRun);
      const debounce = dbRun.debounce as { key: string; delay: string } | null;
      expect(debounce?.key).toBe("user-123");
      expect(debounce?.delay).toBe("5s");

      // Verify execution status is DELAYED
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("DELAYED");
    } finally {
      await engine.quit();
    }
  });

  containerTest(
    "Debounce: multiple triggers return same run",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // First trigger creates run
        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_deb1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "user-123",
              delay: "5s",
            },
          },
          prisma
        );

        // Second trigger should return same run
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_deb2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "user-123",
              delay: "5s",
            },
          },
          prisma
        );

        // Both should return the same run (first run wins)
        expect(run2.id).toBe(run1.id);
        expect(run2.friendlyId).toBe(run1.friendlyId);

        // Only one run should exist in DB
        const runs = await prisma.taskRun.findMany({
          where: {
            taskIdentifier,
            runtimeEnvironmentId: authenticatedEnvironment.id,
          },
        });
        expect(runs.length).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce: delay extension on subsequent triggers",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
          // Disable quantization so this test can observe sub-second extensions.
          quantizeNewDelayUntilMs: 0,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const initialDelay = 1000;
        const initialDelayUntil = new Date(Date.now() + initialDelay);

        // First trigger
        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_deb1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: initialDelayUntil,
            debounce: {
              key: "user-123",
              delay: "1s",
            },
          },
          prisma
        );

        const originalDelayUntil = run1.delayUntil;
        assertNonNullable(originalDelayUntil);

        // Wait a bit then trigger again
        await setTimeout(300);

        // Second trigger should extend the delay
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_deb2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 1000),
            debounce: {
              key: "user-123",
              delay: "1s",
            },
          },
          prisma
        );

        // Same run returned
        expect(run2.id).toBe(run1.id);

        // delayUntil should have been extended
        const updatedRun = await prisma.taskRun.findFirst({
          where: { id: run1.id },
        });
        assertNonNullable(updatedRun);
        assertNonNullable(updatedRun.delayUntil);

        // The new delayUntil should be later than the original
        expect(updatedRun.delayUntil.getTime()).toBeGreaterThan(originalDelayUntil.getTime());
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce: different keys create separate runs",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Trigger with key "user-123"
        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_deb1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "user-123",
              delay: "5s",
            },
          },
          prisma
        );

        // Trigger with different key "user-456"
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_deb2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "user-456",
              delay: "5s",
            },
          },
          prisma
        );

        // Different keys should create different runs
        expect(run2.id).not.toBe(run1.id);

        const runs = await prisma.taskRun.findMany({
          where: {
            taskIdentifier,
            runtimeEnvironmentId: authenticatedEnvironment.id,
          },
        });
        expect(runs.length).toBe(2);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce: run executes after final delay",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // First trigger with 1s delay
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_deb1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 1000),
            debounce: {
              key: "user-123",
              delay: "1s",
            },
          },
          prisma
        );

        // Verify it's in DELAYED status
        let executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("DELAYED");

        // Wait for delay to pass
        await setTimeout(1500);

        // Should now be QUEUED
        executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("QUEUED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce: no longer works after run is enqueued",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // First trigger with short delay
        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_deb1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 300),
            debounce: {
              key: "user-123",
              delay: "300ms",
            },
          },
          prisma
        );

        // Wait for run to be enqueued
        await setTimeout(800);

        // Verify first run is now QUEUED
        const executionData = await engine.getRunExecutionData({ runId: run1.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("QUEUED");

        // New trigger with same key should create a NEW run
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_deb2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "user-123",
              delay: "5s",
            },
          },
          prisma
        );

        // Should be a different run
        expect(run2.id).not.toBe(run1.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce: max duration exceeded creates new run",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // Set a very short max debounce duration
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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 500, // Very short max duration
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // First trigger
        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_deb1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 2000),
            debounce: {
              key: "user-123",
              delay: "2s",
            },
          },
          prisma
        );

        // Wait for max duration to be exceeded
        await setTimeout(700);

        // Second trigger should create a new run because max duration exceeded
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_deb2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 2000),
            debounce: {
              key: "user-123",
              delay: "2s",
            },
          },
          prisma
        );

        // Should be a different run because max duration exceeded
        expect(run2.id).not.toBe(run1.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce keys are scoped to task identifier",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier1 = "test-task-1";
        const taskIdentifier2 = "test-task-2";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier1);
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier2);

        // Trigger task 1 with debounce key
        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_task1",
            environment: authenticatedEnvironment,
            taskIdentifier: taskIdentifier1,
            payload: '{"data": "task1"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: `task/${taskIdentifier1}`,
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "shared-key",
              delay: "5s",
            },
          },
          prisma
        );

        // Trigger task 2 with same debounce key - should create separate run
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_task2",
            environment: authenticatedEnvironment,
            taskIdentifier: taskIdentifier2,
            payload: '{"data": "task2"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: `task/${taskIdentifier2}`,
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "shared-key",
              delay: "5s",
            },
          },
          prisma
        );

        // Should be different runs (debounce scoped to task)
        expect(run2.id).not.toBe(run1.id);
        expect(run1.taskIdentifier).toBe(taskIdentifier1);
        expect(run2.taskIdentifier).toBe(taskIdentifier2);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce with triggerAndWait: parent blocked by debounced child run",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const parentTask = "parent-task";
        const childTask = "child-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

        // Trigger parent run
        const parentRun = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_parent1",
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

        // Dequeue parent and create the attempt
        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        await engine.startRunAttempt({
          runId: parentRun.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        // First triggerAndWait with debounce - creates child run
        const childRun1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_child1",
            environment: authenticatedEnvironment,
            taskIdentifier: childTask,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            queue: `task/${childTask}`,
            isTest: false,
            tags: [],
            workerQueue: "main",
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun.id,
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "user-123",
              delay: "5s",
            },
          },
          prisma
        );

        // Verify parent is blocked
        const parentExecData1 = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentExecData1);
        expect(parentExecData1.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        // Verify child run is in DELAYED status
        const childExecData1 = await engine.getRunExecutionData({ runId: childRun1.id });
        assertNonNullable(childExecData1);
        expect(childExecData1.snapshot.executionStatus).toBe("DELAYED");

        // Check that parent is blocked by the child's waitpoint
        const runWaitpoint = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: parentRun.id,
          },
          include: {
            waitpoint: true,
          },
        });
        assertNonNullable(runWaitpoint);
        expect(runWaitpoint.waitpoint.type).toBe("RUN");
        expect(runWaitpoint.waitpoint.completedByTaskRunId).toBe(childRun1.id);

        // Second triggerAndWait with same debounce key should return same child run
        const childRun2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_child2",
            environment: authenticatedEnvironment,
            taskIdentifier: childTask,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12347",
            spanId: "s12347",
            queue: `task/${childTask}`,
            isTest: false,
            tags: [],
            workerQueue: "main",
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun.id,
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "user-123",
              delay: "5s",
            },
          },
          prisma
        );

        // Should return the same child run (debounced)
        expect(childRun2.id).toBe(childRun1.id);

        // Only one child run should exist
        const childRuns = await prisma.taskRun.findMany({
          where: {
            taskIdentifier: childTask,
            runtimeEnvironmentId: authenticatedEnvironment.id,
          },
        });
        expect(childRuns.length).toBe(1);

        // Parent should still be blocked by the same child run's waitpoint
        const parentExecData2 = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentExecData2);
        expect(parentExecData2.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce with triggerAndWait: second parent also blocked by same child",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const parentTask = "parent-task";
        const childTask = "child-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

        // Trigger first parent run
        const parentRun1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_parent1",
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

        // Dequeue first parent and start attempt
        await setTimeout(500);
        const dequeued1 = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        await engine.startRunAttempt({
          runId: parentRun1.id,
          snapshotId: dequeued1[0].snapshot.id,
        });

        // First parent triggers child with debounce
        const childRun1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_child1",
            environment: authenticatedEnvironment,
            taskIdentifier: childTask,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            queue: `task/${childTask}`,
            isTest: false,
            tags: [],
            workerQueue: "main",
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun1.id,
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "shared-key",
              delay: "5s",
            },
          },
          prisma
        );

        // Verify first parent is blocked
        const parent1ExecData = await engine.getRunExecutionData({ runId: parentRun1.id });
        assertNonNullable(parent1ExecData);
        expect(parent1ExecData.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        // Trigger second parent run
        const parentRun2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_parent2",
            environment: authenticatedEnvironment,
            taskIdentifier: parentTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12347",
            spanId: "s12347",
            queue: `task/${parentTask}`,
            isTest: false,
            tags: [],
            workerQueue: "main",
          },
          prisma
        );

        // Dequeue second parent and start attempt
        await setTimeout(500);
        const dequeued2 = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12346",
          workerQueue: "main",
        });
        await engine.startRunAttempt({
          runId: parentRun2.id,
          snapshotId: dequeued2[0].snapshot.id,
        });

        // Second parent triggers same child with debounce - should return existing child
        const childRun2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_child2",
            environment: authenticatedEnvironment,
            taskIdentifier: childTask,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12348",
            spanId: "s12348",
            queue: `task/${childTask}`,
            isTest: false,
            tags: [],
            workerQueue: "main",
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun2.id,
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "shared-key",
              delay: "5s",
            },
          },
          prisma
        );

        // Should return the same child run
        expect(childRun2.id).toBe(childRun1.id);

        // Second parent should also be blocked by the same child run
        const parent2ExecData = await engine.getRunExecutionData({ runId: parentRun2.id });
        assertNonNullable(parent2ExecData);
        expect(parent2ExecData.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        // Both parents should have waitpoints pointing to the same child
        const waitpoints = await prisma.taskRunWaitpoint.findMany({
          where: {
            taskRunId: { in: [parentRun1.id, parentRun2.id] },
          },
          include: {
            waitpoint: true,
          },
        });
        expect(waitpoints.length).toBe(2);
        expect(waitpoints[0].waitpoint.completedByTaskRunId).toBe(childRun1.id);
        expect(waitpoints[1].waitpoint.completedByTaskRunId).toBe(childRun1.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce: keys scoped to environment",
    async ({ prisma, redisOptions }) => {
      // Create production environment (also creates org and project)
      const prodEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // Create a second environment (development) within the same org/project
      const devEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          type: "DEVELOPMENT",
          slug: "dev-slug",
          projectId: prodEnvironment.projectId,
          organizationId: prodEnvironment.organizationId,
          apiKey: "dev_api_key",
          pkApiKey: "dev_pk_api_key",
          shortcode: "dev_short",
          maximumConcurrencyLimit: 10,
        },
        include: {
          project: true,
          organization: true,
          orgMember: true,
        },
      });

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, prodEnvironment, taskIdentifier);
        await setupBackgroundWorker(engine, devEnvironment, taskIdentifier);

        // Trigger in production environment
        const runProd = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_prod1",
            environment: prodEnvironment,
            taskIdentifier,
            payload: '{"env": "prod"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "same-key",
              delay: "5s",
            },
          },
          prisma
        );

        // Trigger in development environment with same key - should create separate run
        const runDev = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_dev1",
            environment: devEnvironment,
            taskIdentifier,
            payload: '{"env": "dev"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "same-key",
              delay: "5s",
            },
          },
          prisma
        );

        // Should be different runs (debounce scoped to environment)
        expect(runDev.id).not.toBe(runProd.id);
        expect(runProd.runtimeEnvironmentId).toBe(prodEnvironment.id);
        expect(runDev.runtimeEnvironmentId).toBe(devEnvironment.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce: concurrent triggers only create one run (distributed race protection)",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Trigger multiple runs concurrently with the same debounce key
        // This simulates the distributed race condition where multiple servers
        // try to create runs at the exact same time
        const concurrentTriggers = Promise.all([
          engine.trigger(
            {
              number: 1,
              friendlyId: "run_conc1",
              environment: authenticatedEnvironment,
              taskIdentifier,
              payload: '{"data": "first"}',
              payloadType: "application/json",
              context: {},
              traceContext: {},
              traceId: "t12345",
              spanId: "s12345",
              workerQueue: "main",
              queue: "task/test-task",
              isTest: false,
              tags: [],
              delayUntil: new Date(Date.now() + 5000),
              debounce: {
                key: "concurrent-key",
                delay: "5s",
              },
            },
            prisma
          ),
          engine.trigger(
            {
              number: 2,
              friendlyId: "run_conc2",
              environment: authenticatedEnvironment,
              taskIdentifier,
              payload: '{"data": "second"}',
              payloadType: "application/json",
              context: {},
              traceContext: {},
              traceId: "t12346",
              spanId: "s12346",
              workerQueue: "main",
              queue: "task/test-task",
              isTest: false,
              tags: [],
              delayUntil: new Date(Date.now() + 5000),
              debounce: {
                key: "concurrent-key",
                delay: "5s",
              },
            },
            prisma
          ),
          engine.trigger(
            {
              number: 3,
              friendlyId: "run_conc3",
              environment: authenticatedEnvironment,
              taskIdentifier,
              payload: '{"data": "third"}',
              payloadType: "application/json",
              context: {},
              traceContext: {},
              traceId: "t12347",
              spanId: "s12347",
              workerQueue: "main",
              queue: "task/test-task",
              isTest: false,
              tags: [],
              delayUntil: new Date(Date.now() + 5000),
              debounce: {
                key: "concurrent-key",
                delay: "5s",
              },
            },
            prisma
          ),
        ]);

        const [run1, run2, run3] = await concurrentTriggers;

        // All should return the same run (one won the claim, others waited and got it)
        expect(run2.id).toBe(run1.id);
        expect(run3.id).toBe(run1.id);

        // Only one run should exist in DB
        const runs = await prisma.taskRun.findMany({
          where: {
            taskIdentifier,
            runtimeEnvironmentId: authenticatedEnvironment.id,
          },
        });
        expect(runs.length).toBe(1);

        // The run should be in DELAYED status
        const executionData = await engine.getRunExecutionData({ runId: run1.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("DELAYED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce trailing mode: updates payload on subsequent triggers",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // First trigger creates run with trailing mode
        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_trailing1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "trailing-key",
              delay: "5s",
              mode: "trailing",
            },
          },
          prisma
        );

        expect(run1.friendlyId).toBe("run_trailing1");
        expect(run1.payload).toBe('{"data": "first"}');

        // Second trigger with trailing mode should update the payload
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_trailing2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "trailing-key",
              delay: "5s",
              mode: "trailing",
            },
          },
          prisma
        );

        // Should return the same run
        expect(run2.id).toBe(run1.id);

        // Verify the payload was updated to the second trigger's payload
        const dbRun = await prisma.taskRun.findFirst({
          where: { id: run1.id },
        });
        assertNonNullable(dbRun);
        expect(dbRun.payload).toBe('{"data": "second"}');
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce trailing mode: updates metadata on subsequent triggers",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // First trigger with metadata
        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_trailingmeta1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            metadata: '{"version": 1}',
            metadataType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "trailing-meta-key",
              delay: "5s",
              mode: "trailing",
            },
          },
          prisma
        );

        // Second trigger with different metadata
        await engine.trigger(
          {
            number: 2,
            friendlyId: "run_trailingmeta2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            metadata: '{"version": 2, "extra": "field"}',
            metadataType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "trailing-meta-key",
              delay: "5s",
              mode: "trailing",
            },
          },
          prisma
        );

        // Verify metadata was updated
        const dbRun = await prisma.taskRun.findFirst({
          where: { id: run1.id },
        });
        assertNonNullable(dbRun);
        expect(dbRun.metadata).toBe('{"version": 2, "extra": "field"}');
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce trailing mode: updates maxAttempts and maxDuration",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // First trigger with maxAttempts and maxDuration
        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_trailingopts1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            maxAttempts: 3,
            maxDurationInSeconds: 60,
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "trailing-opts-key",
              delay: "5s",
              mode: "trailing",
            },
          },
          prisma
        );

        // Verify initial values
        let dbRun = await prisma.taskRun.findFirst({
          where: { id: run1.id },
        });
        assertNonNullable(dbRun);
        expect(dbRun.maxAttempts).toBe(3);
        expect(dbRun.maxDurationInSeconds).toBe(60);

        // Second trigger with different maxAttempts and maxDuration
        await engine.trigger(
          {
            number: 2,
            friendlyId: "run_trailingopts2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            maxAttempts: 5,
            maxDurationInSeconds: 120,
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "trailing-opts-key",
              delay: "5s",
              mode: "trailing",
            },
          },
          prisma
        );

        // Verify values were updated
        dbRun = await prisma.taskRun.findFirst({
          where: { id: run1.id },
        });
        assertNonNullable(dbRun);
        expect(dbRun.maxAttempts).toBe(5);
        expect(dbRun.maxDurationInSeconds).toBe(120);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce leading mode (default): does NOT update payload",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // First trigger creates run (leading mode - default)
        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_leading1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "leading-key",
              delay: "5s",
              // mode: "leading" is default, not specifying it
            },
          },
          prisma
        );

        // Second trigger should NOT update the payload (leading mode)
        await engine.trigger(
          {
            number: 2,
            friendlyId: "run_leading2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "leading-key",
              delay: "5s",
            },
          },
          prisma
        );

        // Verify the payload is still the first trigger's payload
        const dbRun = await prisma.taskRun.findFirst({
          where: { id: run1.id },
        });
        assertNonNullable(dbRun);
        expect(dbRun.payload).toBe('{"data": "first"}');
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "registerDebouncedRun: atomic claim prevents overwrite when claim is lost",
    async ({ prisma, redisOptions }) => {
      // This test verifies the fix for the TOCTOU race condition in registerDebouncedRun.
      // The race occurs when:
      // 1. Server A claims debounce key with claimId-A
      // 2. Server B claims same key with claimId-B (after A's claim expires)
      // 3. Server B registers runId-B successfully
      // 4. Server A attempts to register runId-A with stale claimId-A
      // Without the fix, step 4 would overwrite runId-B. With the fix, it fails atomically.

      const { createRedisClient } = await import("@internal/redis");

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      // Create a separate Redis client to simulate "another server" modifying keys directly
      const simulatedServerRedis = createRedisClient({
        ...redisOptions,
        keyPrefix: `${redisOptions.keyPrefix ?? ""}debounce:`,
      });

      try {
        const taskIdentifier = "test-task";
        const debounceKey = "race-test-key";
        const environmentId = authenticatedEnvironment.id;
        const delayUntil = new Date(Date.now() + 60_000);

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Construct the Redis key (same format as DebounceSystem.getDebounceRedisKey)
        const redisKey = `${environmentId}:${taskIdentifier}:${debounceKey}`;

        // Step 1: Server A claims the key with claimId-A
        const claimIdA = "claim-server-A";
        await simulatedServerRedis.set(redisKey, `pending:${claimIdA}`, "PX", 60_000);

        // Step 2 & 3: Simulate Server B claiming and registering (after A's claim "expires")
        // In reality, this simulates the race where B's claim overwrites A's pending claim
        const runIdB = "run_server_B";
        await simulatedServerRedis.set(redisKey, runIdB, "PX", 60_000);

        // Verify Server B's registration is in place
        const valueAfterB = await simulatedServerRedis.get(redisKey);
        expect(valueAfterB).toBe(runIdB);

        // Step 4: Server A attempts to register with its stale claimId-A
        // This should FAIL because the key no longer contains "pending:claim-server-A"
        const runIdA = "run_server_A";
        const registered = await engine.debounceSystem.registerDebouncedRun({
          runId: runIdA,
          environmentId,
          taskIdentifier,
          debounceKey,
          delayUntil,
          claimId: claimIdA, // Stale claim ID
        });

        // Step 5: Verify Server A's registration failed
        expect(registered).toBe(false);

        // Step 6: Verify Redis still contains runId-B (not overwritten by Server A)
        const finalValue = await simulatedServerRedis.get(redisKey);
        expect(finalValue).toBe(runIdB);
      } finally {
        await simulatedServerRedis.quit();
        await engine.quit();
      }
    }
  );

  containerTest(
    "waitForExistingRun: returns claimId when key expires during wait",
    async ({ prisma, redisOptions }) => {
      // This test verifies the fix for the race condition where waitForExistingRun
      // returns { status: "new" } without a claimId. Without the fix:
      // 1. Server A's pending claim expires
      // 2. Server B's waitForExistingRun detects key is gone, returns { status: "new" } (no claimId)
      // 3. Server C atomically claims the key and registers runId-C
      // 4. Server B calls registerDebouncedRun without claimId, does plain SET, overwrites runId-C
      //
      // With the fix, step 2 atomically claims the key before returning, preventing step 4's overwrite.

      const { createRedisClient } = await import("@internal/redis");

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      // Create a separate Redis client to simulate "another server" modifying keys directly
      const simulatedServerRedis = createRedisClient({
        ...redisOptions,
        keyPrefix: `${redisOptions.keyPrefix ?? ""}debounce:`,
      });

      try {
        const taskIdentifier = "test-task";
        const debounceKey = "wait-race-test-key";
        const environmentId = authenticatedEnvironment.id;

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Construct the Redis key (same format as DebounceSystem.getDebounceRedisKey)
        const redisKey = `${environmentId}:${taskIdentifier}:${debounceKey}`;

        // Step 1: Server A claims the key with a pending claim
        const claimIdA = "claim-server-A";
        await simulatedServerRedis.set(redisKey, `pending:${claimIdA}`, "PX", 60_000);

        // Step 2: Delete the key to simulate Server A's claim expiring
        await simulatedServerRedis.del(redisKey);

        // Step 3: Server B calls handleDebounce - since key is gone, it should atomically claim
        const debounceResult = await engine.debounceSystem.handleDebounce({
          environmentId,
          taskIdentifier,
          debounce: {
            key: debounceKey,
            delay: "5s",
          },
        });

        // Step 4: Verify result is { status: "new" } WITH a claimId
        expect(debounceResult.status).toBe("new");
        if (debounceResult.status === "new") {
          expect(debounceResult.claimId).toBeDefined();
          expect(typeof debounceResult.claimId).toBe("string");
          expect(debounceResult.claimId!.length).toBeGreaterThan(0);

          // Step 5: Verify the key now contains Server B's pending claim
          const valueAfterB = await simulatedServerRedis.get(redisKey);
          expect(valueAfterB).toBe(`pending:${debounceResult.claimId}`);

          // Step 6: Server C tries to claim the same key - should fail
          const claimIdC = "claim-server-C";
          const claimResultC = await simulatedServerRedis.set(
            redisKey,
            `pending:${claimIdC}`,
            "PX",
            60_000,
            "NX"
          );
          expect(claimResultC).toBeNull(); // NX fails because key exists

          // Step 7: Server B registers its run using its claimId
          const runIdB = "run_server_B";
          const delayUntil = new Date(Date.now() + 60_000);
          const registered = await engine.debounceSystem.registerDebouncedRun({
            runId: runIdB,
            environmentId,
            taskIdentifier,
            debounceKey,
            delayUntil,
            claimId: debounceResult.claimId,
          });

          // Step 8: Verify Server B's registration succeeded
          expect(registered).toBe(true);

          // Step 9: Verify Redis contains Server B's run ID
          const finalValue = await simulatedServerRedis.get(redisKey);
          expect(finalValue).toBe(runIdB);
        }
      } finally {
        await simulatedServerRedis.quit();
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce: per-trigger maxDelay overrides global maxDebounceDuration",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // Set a long global max debounce duration (1 minute)
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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000, // 1 minute global max
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // First trigger with a very short per-trigger maxDelay (1 second)
        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_maxwait1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "maxwait-key",
              delay: "5s",
              maxDelay: "1s", // Very short per-trigger maxDelay (1 second)
            },
          },
          prisma
        );

        expect(run1.friendlyId).toBe("run_maxwait1");

        // Wait for the per-trigger maxDelay to be exceeded (1.5s > 1s)
        await setTimeout(1500);

        // Second trigger should create a new run because per-trigger maxDelay exceeded
        // (even though global maxDebounceDurationMs is 60 seconds)
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_maxwait2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "maxwait-key",
              delay: "5s",
              maxDelay: "1s",
            },
          },
          prisma
        );

        // Should be a different run because per-trigger maxDelay was exceeded
        expect(run2.id).not.toBe(run1.id);
        expect(run2.friendlyId).toBe("run_maxwait2");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce: falls back to global config when maxDelay not specified",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // Set a very short global max debounce duration (1 second)
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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 1000, // 1 second global max
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // First trigger without maxDelay - should use global config
        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_noglobal1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "global-fallback-key",
              delay: "5s",
              // No maxDelay specified - should use global maxDebounceDurationMs
            },
          },
          prisma
        );

        // Wait for global maxDebounceDurationMs to be exceeded (1.5s > 1s)
        await setTimeout(1500);

        // Second trigger should create a new run because global max exceeded
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_noglobal2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "global-fallback-key",
              delay: "5s",
            },
          },
          prisma
        );

        // Should be a different run because global max exceeded
        expect(run2.id).not.toBe(run1.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce: long maxDelay allows more debounce time than global config",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // Set a short global max debounce duration (1 second)
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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 1000, // 1 second global max
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // First trigger with long maxDelay that overrides the short global config
        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_longmax1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 2000),
            debounce: {
              key: "long-maxwait-key",
              delay: "2s",
              maxDelay: "60s", // Long per-trigger maxDelay overrides short global config
            },
          },
          prisma
        );

        // Wait past the global maxDebounceDurationMs (1s) but within our per-trigger maxDelay (60s)
        await setTimeout(1500);

        // Second trigger should return SAME run because per-trigger maxDelay is 60s
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_longmax2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 2000),
            debounce: {
              key: "long-maxwait-key",
              delay: "2s",
              maxDelay: "60s",
            },
          },
          prisma
        );

        // Should be the SAME run because per-trigger maxDelay allows it
        expect(run2.id).toBe(run1.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce fast-path: subsequent triggers within the same quantization bucket skip the lock",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
          // Wide bucket so the second trigger is guaranteed to land in the same one.
          quantizeNewDelayUntilMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_fp1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_fp_1",
            spanId: "s_fp_1",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "fast-path-key",
              delay: "5s",
            },
          },
          prisma
        );

        const originalDelayUntil = run1.delayUntil;
        assertNonNullable(originalDelayUntil);

        // Update the delayUntil directly to a far-future value, simulating a
        // previous trigger that already pushed the bucket forward. The next
        // call's quantized newDelayUntil will land at-or-before this, so the
        // fast-path should skip the lock and leave delayUntil untouched.
        const farFuture = new Date(Date.now() + 10 * 60_000);
        await prisma.taskRun.update({
          where: { id: run1.id },
          data: { delayUntil: farFuture },
        });

        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_fp2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_fp_2",
            spanId: "s_fp_2",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "fast-path-key",
              delay: "5s",
            },
          },
          prisma
        );

        expect(run2.id).toBe(run1.id);

        const updatedRun = await prisma.taskRun.findFirst({
          where: { id: run1.id },
        });
        assertNonNullable(updatedRun);
        assertNonNullable(updatedRun.delayUntil);

        // delayUntil must NOT have been bumped backward by the second trigger,
        // proving we short-circuited before taking the lock or rescheduling.
        expect(updatedRun.delayUntil.getTime()).toBe(farFuture.getTime());
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce fast-path: trailing mode with updateData still takes the lock",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
          quantizeNewDelayUntilMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_trfp1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_trfp_1",
            spanId: "s_trfp_1",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "trailing-fast-path-key",
              delay: "5s",
              mode: "trailing",
            },
          },
          prisma
        );

        // Push delayUntil far forward so the fast-path *would* short-circuit
        // for leading mode. Trailing-mode triggers with updateData must still
        // take the lock so the data update is applied.
        const farFuture = new Date(Date.now() + 10 * 60_000);
        await prisma.taskRun.update({
          where: { id: run1.id },
          data: { delayUntil: farFuture },
        });

        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_trfp2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_trfp_2",
            spanId: "s_trfp_2",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "trailing-fast-path-key",
              delay: "5s",
              mode: "trailing",
              updateData: {
                payload: '{"data": "second"}',
                payloadType: "application/json",
              },
            },
          },
          prisma
        );

        expect(run2.id).toBe(run1.id);

        const updatedRun = await prisma.taskRun.findFirst({
          where: { id: run1.id },
        });
        assertNonNullable(updatedRun);
        // Trailing-mode update went through the lock and rewrote the payload.
        expect(updatedRun.payload).toBe('{"data": "second"}');
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce: quantized newDelayUntil falls on a bucket boundary",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          baseCostInCents: 0.0001,
        },
        debounce: {
          maxDebounceDurationMs: 60_000,
          quantizeNewDelayUntilMs: 1000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_q1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_q_1",
            spanId: "s_q_1",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "quantize-key",
              delay: "5s",
            },
          },
          prisma
        );

        // Force a meaningfully-later bucket so the second trigger pushes
        // delayUntil forward through the lock.
        await prisma.taskRun.update({
          where: { id: run1.id },
          data: { delayUntil: new Date(Date.now() - 1000) },
        });

        await engine.trigger(
          {
            number: 2,
            friendlyId: "run_q2",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_q_2",
            spanId: "s_q_2",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "quantize-key",
              delay: "5s",
            },
          },
          prisma
        );

        const updatedRun = await prisma.taskRun.findFirst({
          where: { id: run1.id },
        });
        assertNonNullable(updatedRun);
        assertNonNullable(updatedRun.delayUntil);

        // The new delayUntil should be aligned to a 1s bucket boundary.
        expect(updatedRun.delayUntil.getTime() % 1000).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce: lock contention falls back to returning existing run",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

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
          // Force lock acquisition to fail almost immediately so we can
          // exercise the contention safety net deterministically.
          retryConfig: {
            maxAttempts: 0,
            baseDelay: 1,
            maxDelay: 1,
            maxTotalWaitTime: 1,
          },
          duration: 30_000,
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
        debounce: {
          maxDebounceDurationMs: 60_000,
          // Disable fast-path so the request is forced through the lock and
          // we can prove the contention fallback handles 5xx prevention.
          fastPathSkipEnabled: false,
          quantizeNewDelayUntilMs: 0,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_lc1",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_lc_1",
            spanId: "s_lc_1",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "contention-key",
              delay: "5s",
            },
          },
          prisma
        );

        // Hold the underlying redlock key from a separate Redis connection so
        // the engine's runLock cannot acquire it. Since we configured
        // `retryConfig.maxAttempts: 0` and `maxTotalWaitTime: 1`, the second
        // trigger should hit the contention fallback rather than bubble a 5xx.
        // Note: the prefix template here intentionally matches what the engine
        // builds at index.ts:120 (no `?? ""` fallback) so that the keys line up
        // even when redisOptions.keyPrefix is undefined.
        const blockingRedis = createRedisClient({
          ...redisOptions,
          keyPrefix: `${redisOptions.keyPrefix}runlock:`,
        });

        const originalDelayUntil = run1.delayUntil;
        assertNonNullable(originalDelayUntil);

        try {
          const blockResult = await blockingRedis.set(
            run1.id,
            "test-blocker",
            "PX",
            30_000,
            "NX"
          );
          expect(blockResult).toBe("OK");

          const run2 = await engine.trigger(
            {
              number: 2,
              friendlyId: "run_lc2",
              environment: authenticatedEnvironment,
              taskIdentifier,
              payload: '{"data": "second"}',
              payloadType: "application/json",
              context: {},
              traceContext: {},
              traceId: "t_lc_2",
              spanId: "s_lc_2",
              workerQueue: "main",
              queue: "task/test-task",
              isTest: false,
              tags: [],
              delayUntil: new Date(Date.now() + 5000),
              debounce: {
                key: "contention-key",
                delay: "5s",
              },
            },
            prisma
          );

          // We did NOT 5xx; we returned the existing run.
          expect(run2.id).toBe(run1.id);

          // Prove the fallback actually ran rather than the lock being acquired
          // normally: the second trigger could not push delayUntil forward
          // because rescheduling is skipped on contention.
          const updatedRun = await prisma.taskRun.findFirst({
            where: { id: run1.id },
          });
          assertNonNullable(updatedRun);
          assertNonNullable(updatedRun.delayUntil);
          expect(updatedRun.delayUntil.getTime()).toBe(originalDelayUntil.getTime());
        } finally {
          await blockingRedis.del(run1.id);
          await blockingRedis.quit();
        }
      } finally {
        await engine.quit();
      }
    }
  );
});

