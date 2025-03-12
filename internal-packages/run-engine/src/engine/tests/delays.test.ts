import {
  containerTest,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
  assertNonNullable,
} from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";
import { TaskRunErrorCodes } from "@trigger.dev/core/v3";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine delays", () => {
  containerTest("Run start delayed", async ({ prisma, redisOptions }) => {
    //create environment
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
      tracer: trace.getTracer("test", "0.0.0"),
    });

    try {
      const taskIdentifier = "test-task";

      //create background worker
      const backgroundWorker = await setupBackgroundWorker(
        prisma,
        authenticatedEnvironment,
        taskIdentifier
      );

      //trigger the run
      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_1234",
          environment: authenticatedEnvironment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          masterQueue: "main",
          queueName: "task/test-task",
          isTest: false,
          tags: [],
          delayUntil: new Date(Date.now() + 500),
        },
        prisma
      );

      //should be created but not queued yet
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("RUN_CREATED");

      //wait for 1 seconds
      await setTimeout(1_000);

      //should now be queued
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("QUEUED");
    } finally {
      engine.quit();
    }
  });

  containerTest("Rescheduling a delayed run", async ({ prisma, redisOptions }) => {
    //create environment
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
      tracer: trace.getTracer("test", "0.0.0"),
    });

    try {
      const taskIdentifier = "test-task";

      //create background worker
      const backgroundWorker = await setupBackgroundWorker(
        prisma,
        authenticatedEnvironment,
        taskIdentifier
      );

      //trigger the run
      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_1234",
          environment: authenticatedEnvironment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          masterQueue: "main",
          queueName: "task/test-task",
          isTest: false,
          tags: [],
          delayUntil: new Date(Date.now() + 400),
        },
        prisma
      );

      //should be created but not queued yet
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("RUN_CREATED");

      const rescheduleTo = new Date(Date.now() + 1_500);
      const updatedRun = await engine.rescheduleDelayedRun({
        runId: run.id,
        delayUntil: rescheduleTo,
      });
      expect(updatedRun.delayUntil?.toISOString()).toBe(rescheduleTo.toISOString());

      //wait so the initial delay passes
      await setTimeout(1_000);

      //should still be created
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("RUN_CREATED");

      //wait so the updated delay passes
      await setTimeout(1_750);

      //should now be queued
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("QUEUED");
    } finally {
      engine.quit();
    }
  });

  containerTest("Delayed run with a ttl", async ({ prisma, redisOptions }) => {
    //create environment
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
      tracer: trace.getTracer("test", "0.0.0"),
    });

    try {
      const taskIdentifier = "test-task";

      //create background worker
      const backgroundWorker = await setupBackgroundWorker(
        prisma,
        authenticatedEnvironment,
        taskIdentifier
      );

      //trigger the run
      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_1234",
          environment: authenticatedEnvironment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t12345",
          spanId: "s12345",
          masterQueue: "main",
          queueName: "task/test-task",
          isTest: false,
          tags: [],
          delayUntil: new Date(Date.now() + 1000),
          ttl: "2s",
        },
        prisma
      );

      //should be created but not queued yet
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("RUN_CREATED");
      expect(run.status).toBe("DELAYED");

      //wait for 1 seconds
      await setTimeout(2_500);

      //should now be queued
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("QUEUED");

      const run2 = await prisma.taskRun.findFirstOrThrow({
        where: { id: run.id },
      });

      expect(run2.status).toBe("PENDING");

      //wait for 3 seconds
      await setTimeout(3_000);

      //should now be expired
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("FINISHED");

      const run3 = await prisma.taskRun.findFirstOrThrow({
        where: { id: run.id },
      });

      expect(run3.status).toBe("EXPIRED");
    } finally {
      engine.quit();
    }
  });

  containerTest(
    "Delayed run that fails to enqueue because of a recursive deadlock issue",
    async ({ prisma, redisOptions }) => {
      //create environment
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
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const parentTask = "parent-task";
        const childTask = "child-task";

        //create background worker
        await setupBackgroundWorker(prisma, authenticatedEnvironment, [parentTask, childTask]);

        //trigger the run
        const parentRun = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_p1234",
            environment: authenticatedEnvironment,
            taskIdentifier: parentTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            masterQueue: "main",
            queueName: "shared-queue",
            queue: {
              concurrencyLimit: 1,
            },
            isTest: false,
            tags: [],
          },
          prisma
        );

        const dequeued = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: parentRun.masterQueue,
          maxRunCount: 10,
        });

        expect(dequeued.length).toBe(1);

        const initialExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(initialExecutionData);
        const attemptResult = await engine.startRunAttempt({
          runId: parentRun.id,
          snapshotId: initialExecutionData.snapshot.id,
        });

        expect(attemptResult).toBeDefined();

        const childRun = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_c1234",
            environment: authenticatedEnvironment,
            taskIdentifier: childTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            masterQueue: "main",
            queueName: "shared-queue",
            queue: {
              concurrencyLimit: 1,
            },
            isTest: false,
            tags: [],
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun.id,
          },
          prisma
        );

        const childExecutionData = await engine.getRunExecutionData({ runId: childRun.id });
        assertNonNullable(childExecutionData);
        expect(childExecutionData.snapshot.executionStatus).toBe("QUEUED");

        const parentExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentExecutionData);
        expect(parentExecutionData.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        //dequeue the child run
        const dequeuedChild = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: childRun.masterQueue,
          maxRunCount: 10,
        });

        expect(dequeuedChild.length).toBe(1);

        // Now try and trigger another child run on the same queue
        const childRun2 = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_c12345",
            environment: authenticatedEnvironment,
            taskIdentifier: childTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345_2",
            spanId: "s12345_2",
            masterQueue: "main",
            queueName: "shared-queue",
            queue: {
              concurrencyLimit: 1,
            },
            isTest: false,
            tags: [],
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun.id,
            delayUntil: new Date(Date.now() + 1000),
          },
          prisma
        );

        const executionData = await engine.getRunExecutionData({ runId: childRun2.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("RUN_CREATED");

        await setTimeout(1_500);

        // Now the run should be failed
        const run2 = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun2.id },
        });

        expect(run2.status).toBe("COMPLETED_WITH_ERRORS");
        expect(run2.error).toEqual({
          type: "INTERNAL_ERROR",
          code: TaskRunErrorCodes.RECURSIVE_WAIT_DEADLOCK,
          message: expect.any(String),
        });
      } finally {
        engine.quit();
      }
    }
  );
});
