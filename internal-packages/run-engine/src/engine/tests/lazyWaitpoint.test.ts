import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "node:timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine lazy waitpoint creation", () => {
  containerTest(
    "No waitpoint for standalone trigger (no parent)",
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

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Trigger a run WITHOUT resumeParentOnCompletion
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_standalone1",
            environment: authenticatedEnvironment,
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
            // No resumeParentOnCompletion, no parentTaskRunId
          },
          prisma
        );

        // Verify run was created
        expect(run.friendlyId).toBe("run_standalone1");

        // Verify NO associated waitpoint was created
        const dbRun = await prisma.taskRun.findFirst({
          where: { id: run.id },
          include: { associatedWaitpoint: true },
        });
        assertNonNullable(dbRun);
        expect(dbRun.associatedWaitpoint).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("Waitpoint created for triggerAndWait", async ({ prisma, redisOptions }) => {
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

      // Dequeue parent and start attempt
      await setTimeout(500);
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      await engine.startRunAttempt({
        runId: parentRun.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      // Trigger child with triggerAndWait
      const childRun = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_child1",
          environment: authenticatedEnvironment,
          taskIdentifier: childTask,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12346",
          spanId: "s12346",
          queue: `task/${childTask}`,
          isTest: false,
          tags: [],
          resumeParentOnCompletion: true,
          parentTaskRunId: parentRun.id,
          workerQueue: "main",
        },
        prisma
      );

      // Verify child run has associated waitpoint
      const dbChildRun = await prisma.taskRun.findFirst({
        where: { id: childRun.id },
        include: { associatedWaitpoint: true },
      });
      assertNonNullable(dbChildRun);
      assertNonNullable(dbChildRun.associatedWaitpoint);
      expect(dbChildRun.associatedWaitpoint.type).toBe("RUN");
      expect(dbChildRun.associatedWaitpoint.completedByTaskRunId).toBe(childRun.id);
    } finally {
      await engine.quit();
    }
  });

  containerTest(
    "Completion without waitpoint succeeds",
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

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Trigger a standalone run (no waitpoint)
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_complete1",
            environment: authenticatedEnvironment,
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

        // Verify no waitpoint
        const dbRun = await prisma.taskRun.findFirst({
          where: { id: run.id },
          include: { associatedWaitpoint: true },
        });
        assertNonNullable(dbRun);
        expect(dbRun.associatedWaitpoint).toBeNull();

        // Dequeue and start the run
        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        const attemptResult = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        // Complete the run - should NOT throw even without waitpoint
        const completeResult = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attemptResult.snapshot.id,
          completion: {
            id: run.id,
            ok: true,
            output: '{"result":"success"}',
            outputType: "application/json",
          },
        });

        // Verify run completed successfully
        expect(completeResult.attemptStatus).toBe("RUN_FINISHED");
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.run.status).toBe("COMPLETED_SUCCESSFULLY");
        expect(executionData.snapshot.executionStatus).toBe("FINISHED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Cancellation without waitpoint succeeds",
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

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Trigger a standalone run (no waitpoint)
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_cancel1",
            environment: authenticatedEnvironment,
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

        // Verify no waitpoint
        const dbRun = await prisma.taskRun.findFirst({
          where: { id: run.id },
          include: { associatedWaitpoint: true },
        });
        assertNonNullable(dbRun);
        expect(dbRun.associatedWaitpoint).toBeNull();

        // Cancel the run - should NOT throw even without waitpoint
        const cancelResult = await engine.cancelRun({
          runId: run.id,
          reason: "Test cancellation",
        });

        // Verify run was cancelled
        expect(cancelResult.alreadyFinished).toBe(false);
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.run.status).toBe("CANCELED");
        expect(executionData.snapshot.executionStatus).toBe("FINISHED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "TTL expiration without waitpoint succeeds",
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
          masterQueueConsumersDisabled: true,
          processWorkerQueueDebounceMs: 50,
          ttlSystem: {
            pollIntervalMs: 100,
            batchSize: 10,
          },
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

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Trigger a standalone run with TTL (no waitpoint)
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_ttl1",
            environment: authenticatedEnvironment,
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
            ttl: "1s",
          },
          prisma
        );

        // Verify no waitpoint
        const dbRun = await prisma.taskRun.findFirst({
          where: { id: run.id },
          include: { associatedWaitpoint: true },
        });
        assertNonNullable(dbRun);
        expect(dbRun.associatedWaitpoint).toBeNull();

        // Wait for TTL to expire
        await setTimeout(1_500);

        // Verify run expired successfully (no throw)
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.run.status).toBe("EXPIRED");
        expect(executionData.snapshot.executionStatus).toBe("FINISHED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "getOrCreateRunWaitpoint: returns existing waitpoint",
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

      try {
        const parentTask = "parent-task";
        const childTask = "child-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

        // Create parent run
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

        // Dequeue and start parent
        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        await engine.startRunAttempt({
          runId: parentRun.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        // Create child with triggerAndWait (waitpoint created at trigger time)
        const childRun = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_child1",
            environment: authenticatedEnvironment,
            taskIdentifier: childTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            queue: `task/${childTask}`,
            isTest: false,
            tags: [],
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun.id,
            workerQueue: "main",
          },
          prisma
        );

        // Get the existing waitpoint
        const dbChildRun = await prisma.taskRun.findFirst({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        assertNonNullable(dbChildRun);
        assertNonNullable(dbChildRun.associatedWaitpoint);
        const existingWaitpointId = dbChildRun.associatedWaitpoint.id;

        // Call getOrCreateRunWaitpoint - should return the existing one
        const waitpoint = await engine.getOrCreateRunWaitpoint({
          runId: childRun.id,
          projectId: authenticatedEnvironment.project.id,
          environmentId: authenticatedEnvironment.id,
        });

        assertNonNullable(waitpoint);
        expect(waitpoint.id).toBe(existingWaitpointId);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "getOrCreateRunWaitpoint: creates waitpoint lazily",
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

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Create a standalone run (no waitpoint)
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_lazy1",
            environment: authenticatedEnvironment,
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

        // Verify no waitpoint initially
        const dbRunBefore = await prisma.taskRun.findFirst({
          where: { id: run.id },
          include: { associatedWaitpoint: true },
        });
        assertNonNullable(dbRunBefore);
        expect(dbRunBefore.associatedWaitpoint).toBeNull();

        // Call getOrCreateRunWaitpoint - should create one
        const waitpoint = await engine.getOrCreateRunWaitpoint({
          runId: run.id,
          projectId: authenticatedEnvironment.project.id,
          environmentId: authenticatedEnvironment.id,
        });

        assertNonNullable(waitpoint);
        expect(waitpoint.type).toBe("RUN");
        expect(waitpoint.status).toBe("PENDING");

        // Verify waitpoint is now linked to the run
        const dbRunAfter = await prisma.taskRun.findFirst({
          where: { id: run.id },
          include: { associatedWaitpoint: true },
        });
        assertNonNullable(dbRunAfter);
        assertNonNullable(dbRunAfter.associatedWaitpoint);
        expect(dbRunAfter.associatedWaitpoint.id).toBe(waitpoint.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "getOrCreateRunWaitpoint: returns completed waitpoint for completed run",
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

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Create a standalone run
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_completed1",
            environment: authenticatedEnvironment,
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

        // Dequeue and complete the run
        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        const attemptResult = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: dequeued[0].snapshot.id,
        });
        await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attemptResult.snapshot.id,
          completion: {
            id: run.id,
            ok: true,
            output: '{"result":"done"}',
            outputType: "application/json",
          },
        });

        // Verify run is completed
        const dbRun = await prisma.taskRun.findFirst({
          where: { id: run.id },
        });
        assertNonNullable(dbRun);
        expect(dbRun.status).toBe("COMPLETED_SUCCESSFULLY");

        // Call getOrCreateRunWaitpoint - should create and return a completed waitpoint with run output
        const waitpoint = await engine.getOrCreateRunWaitpoint({
          runId: run.id,
          projectId: authenticatedEnvironment.project.id,
          environmentId: authenticatedEnvironment.id,
        });

        assertNonNullable(waitpoint);
        expect(waitpoint.status).toBe("COMPLETED");
        expect(waitpoint.output).toBe('{"result":"done"}');
        expect(waitpoint.outputType).toBe("application/json");
        expect(waitpoint.outputIsError).toBe(false);

        // Verify waitpoint is linked to run
        const runWithWaitpoint = await prisma.taskRun.findFirst({
          where: { id: run.id },
          include: { associatedWaitpoint: true },
        });
        assertNonNullable(runWithWaitpoint);
        assertNonNullable(runWithWaitpoint.associatedWaitpoint);
        expect(runWithWaitpoint.associatedWaitpoint.id).toBe(waitpoint.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "getOrCreateRunWaitpoint: creates completed waitpoint for failed run",
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

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Create a standalone run
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_failed1",
            environment: authenticatedEnvironment,
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

        // Dequeue and fail the run
        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        const attemptResult = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: dequeued[0].snapshot.id,
        });
        const errorPayload = {
          type: "BUILT_IN_ERROR" as const,
          name: "Error",
          message: "Something broke",
          stackTrace: "Error: Something broke",
        };
        await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attemptResult.snapshot.id,
          completion: {
            id: run.id,
            ok: false,
            error: errorPayload,
          },
        });

        const dbRun = await prisma.taskRun.findFirst({
          where: { id: run.id },
        });
        assertNonNullable(dbRun);
        expect(dbRun.status).toBe("COMPLETED_WITH_ERRORS");

        const waitpoint = await engine.getOrCreateRunWaitpoint({
          runId: run.id,
          projectId: authenticatedEnvironment.project.id,
          environmentId: authenticatedEnvironment.id,
        });

        assertNonNullable(waitpoint);
        expect(waitpoint.status).toBe("COMPLETED");
        expect(waitpoint.outputIsError).toBe(true);
        const parsedOutput = JSON.parse(waitpoint.output ?? "{}");
        expect(parsedOutput.type).toBe("BUILT_IN_ERROR");
        expect(parsedOutput.message).toBe("Something broke");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "getOrCreateRunWaitpoint: concurrent calls create only one waitpoint",
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

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Create a standalone run (no waitpoint)
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_concurrent1",
            environment: authenticatedEnvironment,
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

        // Call getOrCreateRunWaitpoint concurrently from multiple "callers"
        const [waitpoint1, waitpoint2, waitpoint3] = await Promise.all([
          engine.getOrCreateRunWaitpoint({
            runId: run.id,
            projectId: authenticatedEnvironment.project.id,
            environmentId: authenticatedEnvironment.id,
          }),
          engine.getOrCreateRunWaitpoint({
            runId: run.id,
            projectId: authenticatedEnvironment.project.id,
            environmentId: authenticatedEnvironment.id,
          }),
          engine.getOrCreateRunWaitpoint({
            runId: run.id,
            projectId: authenticatedEnvironment.project.id,
            environmentId: authenticatedEnvironment.id,
          }),
        ]);

        // All should return the same waitpoint
        assertNonNullable(waitpoint1);
        assertNonNullable(waitpoint2);
        assertNonNullable(waitpoint3);
        expect(waitpoint2.id).toBe(waitpoint1.id);
        expect(waitpoint3.id).toBe(waitpoint1.id);

        // Verify only one waitpoint exists for this run
        const waitpoints = await prisma.waitpoint.findMany({
          where: { completedByTaskRunId: run.id },
        });
        expect(waitpoints.length).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Debounce lazy creation: first trigger (no parent) -> second trigger (with parent)",
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
        debounce: {
          maxDebounceDurationMs: 60_000,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const parentTask = "parent-task";
        const childTask = "child-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

        // First trigger: standalone (no parent waiting) with debounce
        const run1 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_debounce1",
            environment: authenticatedEnvironment,
            taskIdentifier: childTask,
            payload: '{"data": "first"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: `task/${childTask}`,
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "lazy-test",
              delay: "5s",
            },
            // No resumeParentOnCompletion, no parentTaskRunId
          },
          prisma
        );

        // Verify no waitpoint initially
        const dbRunBefore = await prisma.taskRun.findFirst({
          where: { id: run1.id },
          include: { associatedWaitpoint: true },
        });
        assertNonNullable(dbRunBefore);
        expect(dbRunBefore.associatedWaitpoint).toBeNull();

        // Create and start parent run
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
            traceId: "t12347",
            spanId: "s12347",
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
          runId: parentRun.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        // Second trigger: with parent waiting (triggerAndWait)
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_debounce2",
            environment: authenticatedEnvironment,
            taskIdentifier: childTask,
            payload: '{"data": "second"}',
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            workerQueue: "main",
            queue: `task/${childTask}`,
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 5000),
            debounce: {
              key: "lazy-test",
              delay: "5s",
            },
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun.id,
          },
          prisma
        );

        // Should return the same debounced run
        expect(run2.id).toBe(run1.id);

        // Verify waitpoint was lazily created
        const dbRunAfter = await prisma.taskRun.findFirst({
          where: { id: run1.id },
          include: { associatedWaitpoint: true },
        });
        assertNonNullable(dbRunAfter);
        assertNonNullable(dbRunAfter.associatedWaitpoint);
        expect(dbRunAfter.associatedWaitpoint.type).toBe("RUN");

        // Verify parent is blocked by the waitpoint
        const parentExecData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentExecData);
        expect(parentExecData.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Lazy waitpoint for already-completed child: parent blocks then resumes with child output",
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

      try {
        const parentTask = "parent-task";
        const childTask = "child-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

        // Create parent run and start it (EXECUTING)
        const parentRun = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_plazy1",
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
        const dequeuedParent = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        await engine.startRunAttempt({
          runId: parentRun.id,
          snapshotId: dequeuedParent[0].snapshot.id,
        });

        // Create child run standalone (no waitpoint), then complete it
        const childRun = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_clazy1",
            environment: authenticatedEnvironment,
            taskIdentifier: childTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            queue: `task/${childTask}`,
            isTest: false,
            tags: [],
            workerQueue: "main",
          },
          prisma
        );

        await setTimeout(500);
        const dequeuedChild = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        const childAttemptResult = await engine.startRunAttempt({
          runId: childRun.id,
          snapshotId: dequeuedChild[0].snapshot.id,
        });
        await engine.completeRunAttempt({
          runId: childRun.id,
          snapshotId: childAttemptResult.snapshot.id,
          completion: {
            id: childRun.id,
            ok: true,
            output: '{"idempotent":"result"}',
            outputType: "application/json",
          },
        });

        const childAfter = await prisma.taskRun.findFirst({
          where: { id: childRun.id },
          include: { associatedWaitpoint: true },
        });
        assertNonNullable(childAfter);
        expect(childAfter.status).toBe("COMPLETED_SUCCESSFULLY");
        expect(childAfter.associatedWaitpoint).toBeNull();

        // Simulate idempotency/debounce path: getOrCreateRunWaitpoint for completed child, then block parent
        const waitpoint = await engine.getOrCreateRunWaitpoint({
          runId: childRun.id,
          projectId: authenticatedEnvironment.project.id,
          environmentId: authenticatedEnvironment.id,
        });

        assertNonNullable(waitpoint);
        expect(waitpoint.status).toBe("COMPLETED");
        expect(waitpoint.output).toBe('{"idempotent":"result"}');

        await engine.blockRunWithWaitpoint({
          runId: parentRun.id,
          waitpoints: waitpoint.id,
          spanIdToComplete: "span-to-complete",
          projectId: authenticatedEnvironment.project.id,
          organizationId: authenticatedEnvironment.organizationId,
          tx: prisma,
        });

        // Worker will process continueRunIfUnblocked (waitpoint already completed)
        await setTimeout(500);

        const parentExecData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentExecData);
        expect(parentExecData.snapshot.executionStatus).toBe("EXECUTING");
        expect(parentExecData.completedWaitpoints?.length).toBe(1);
        expect(parentExecData.completedWaitpoints![0].id).toBe(waitpoint.id);
        expect(parentExecData.completedWaitpoints![0].output).toBe('{"idempotent":"result"}');
      } finally {
        await engine.quit();
      }
    }
  );
});
