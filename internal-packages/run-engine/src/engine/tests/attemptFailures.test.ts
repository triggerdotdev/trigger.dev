import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

describe("RunEngine attempt failures", () => {
  containerTest("Retry user error and succeed", async ({ prisma, redisOptions }) => {
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
        engine,
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
          queue: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );

      //dequeue the run
      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      //create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      //fail the attempt
      const error = {
        type: "BUILT_IN_ERROR" as const,
        name: "UserError",
        message: "This is a user error",
        stackTrace: "Error: This is a user error\n    at <anonymous>:1:1",
      };
      const result = await engine.completeRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: attemptResult.snapshot.id,
        completion: {
          ok: false,
          id: dequeued[0].run.id,
          error,
          retry: {
            timestamp: Date.now(),
            delay: 0,
          },
        },
      });
      expect(result.attemptStatus).toBe("RETRY_IMMEDIATELY");
      expect(result.snapshot.executionStatus).toBe("EXECUTING");
      expect(result.run.status).toBe("RETRYING_AFTER_FAILURE");

      //state should be pending
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("EXECUTING");
      //only when the new attempt is created, should the attempt be increased
      expect(executionData3.run.attemptNumber).toBe(1);
      expect(executionData3.run.status).toBe("RETRYING_AFTER_FAILURE");

      //create a second attempt
      const attemptResult2 = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: executionData3.snapshot.id,
      });
      expect(attemptResult2.run.attemptNumber).toBe(2);

      //now complete it successfully
      const result2 = await engine.completeRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: attemptResult2.snapshot.id,
        completion: {
          ok: true,
          id: dequeued[0].run.id,
          output: `{"foo":"bar"}`,
          outputType: "application/json",
        },
      });
      expect(result2.snapshot.executionStatus).toBe("FINISHED");
      expect(result2.run.attemptNumber).toBe(2);
      expect(result2.run.status).toBe("COMPLETED_SUCCESSFULLY");

      //waitpoint should have been completed, with the output
      const runWaitpointAfter = await prisma.waitpoint.findMany({
        where: {
          completedByTaskRunId: run.id,
        },
      });
      expect(runWaitpointAfter.length).toBe(1);
      expect(runWaitpointAfter[0].type).toBe("RUN");
      expect(runWaitpointAfter[0].output).toBe(`{"foo":"bar"}`);
      expect(runWaitpointAfter[0].outputIsError).toBe(false);

      //state should be completed
      const executionData4 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData4);
      expect(executionData4.snapshot.executionStatus).toBe("FINISHED");
      expect(executionData4.run.attemptNumber).toBe(2);
      expect(executionData4.run.status).toBe("COMPLETED_SUCCESSFULLY");
    } finally {
      await engine.quit();
    }
  });

  containerTest("Fail (no more retries)", async ({ prisma, redisOptions }) => {
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
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier, undefined, {
        maxAttempts: 1,
      });

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
          queue: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );

      //dequeue the run
      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      //create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      //fail the attempt
      const error = {
        type: "BUILT_IN_ERROR" as const,
        name: "UserError",
        message: "This is a user error",
        stackTrace: "Error: This is a user error\n    at <anonymous>:1:1",
      };
      const result = await engine.completeRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: attemptResult.snapshot.id,
        completion: {
          ok: false,
          id: dequeued[0].run.id,
          error,
          retry: {
            timestamp: Date.now(),
            delay: 0,
          },
        },
      });
      expect(result.attemptStatus).toBe("RUN_FINISHED");
      expect(result.snapshot.executionStatus).toBe("FINISHED");
      expect(result.run.status).toBe("COMPLETED_WITH_ERRORS");

      //state should be pending
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("FINISHED");
      //only when the new attempt is created, should the attempt be increased
      expect(executionData3.run.attemptNumber).toBe(1);
      expect(executionData3.run.status).toBe("COMPLETED_WITH_ERRORS");
    } finally {
      await engine.quit();
    }
  });

  containerTest("Fail (not a retriable error)", async ({ prisma, redisOptions }) => {
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
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier, undefined, {
        maxAttempts: 1,
      });

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
          queue: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );

      //dequeue the run
      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      //create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      //fail the attempt with an unretriable error
      const error = {
        type: "INTERNAL_ERROR" as const,
        code: "DISK_SPACE_EXCEEDED" as const,
      };
      const result = await engine.completeRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: attemptResult.snapshot.id,
        completion: {
          ok: false,
          id: dequeued[0].run.id,
          error,
          retry: {
            timestamp: Date.now(),
            delay: 0,
          },
        },
      });
      expect(result.attemptStatus).toBe("RUN_FINISHED");
      expect(result.snapshot.executionStatus).toBe("FINISHED");
      expect(result.run.status).toBe("CRASHED");

      //state should be pending
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("FINISHED");
      //only when the new attempt is created, should the attempt be increased
      expect(executionData3.run.attemptNumber).toBe(1);
      expect(executionData3.run.status).toBe("CRASHED");
    } finally {
      await engine.quit();
    }
  });

  containerTest("OOM fail", async ({ prisma, redisOptions }) => {
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
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

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
          queue: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );

      //dequeue the run
      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      //create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      //fail the attempt with an OOM error
      const error = {
        type: "INTERNAL_ERROR" as const,
        code: "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE" as const,
        message: "Process exited with code -1 after signal SIGKILL.",
        stackTrace: "JavaScript heap out of memory",
      };

      const result = await engine.completeRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: attemptResult.snapshot.id,
        completion: {
          ok: false,
          id: dequeued[0].run.id,
          error,
        },
      });

      // The run should be retried with a larger machine
      expect(result.attemptStatus).toBe("RUN_FINISHED");
      expect(result.snapshot.executionStatus).toBe("FINISHED");
      expect(result.run.status).toBe("CRASHED");

      //state should be pending
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("FINISHED");
      expect(executionData.run.attemptNumber).toBe(1);
      expect(executionData.run.status).toBe("CRASHED");
    } finally {
      await engine.quit();
    }
  });

  containerTest("OOM retry on larger machine", async ({ prisma, redisOptions }) => {
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
          "small-2x": {
            name: "small-2x" as const,
            cpu: 1,
            memory: 1,
            centsPerMs: 0.0002,
          },
        },
        baseCostInCents: 0.0001,
      },
      tracer: trace.getTracer("test", "0.0.0"),
    });

    try {
      const taskIdentifier = "test-task";

      //create background worker
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier, undefined, {
        outOfMemory: {
          machine: "small-2x",
        },
      });

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
          queue: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );

      //dequeue the run
      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      //create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      //fail the attempt with an OOM error
      const error = {
        type: "INTERNAL_ERROR" as const,
        code: "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE" as const,
        message: "Process exited with code -1 after signal SIGKILL.",
        stackTrace: "JavaScript heap out of memory",
      };

      const result = await engine.completeRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: attemptResult.snapshot.id,
        completion: {
          ok: false,
          id: dequeued[0].run.id,
          error,
        },
      });

      // The run should be retried with a larger machine
      expect(result.attemptStatus).toBe("RETRY_QUEUED");
      expect(result.snapshot.executionStatus).toBe("QUEUED");
      expect(result.run.status).toBe("RETRYING_AFTER_FAILURE");

      //state should be pending
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("QUEUED");
      expect(executionData.run.attemptNumber).toBe(1);
      expect(executionData.run.status).toBe("RETRYING_AFTER_FAILURE");

      //create a second attempt
      const attemptResult2 = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: executionData.snapshot.id,
      });
      expect(attemptResult2.run.attemptNumber).toBe(2);

      //now complete it successfully
      const result2 = await engine.completeRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: attemptResult2.snapshot.id,
        completion: {
          ok: true,
          id: dequeued[0].run.id,
          output: `{"foo":"bar"}`,
          outputType: "application/json",
        },
      });
      expect(result2.snapshot.executionStatus).toBe("FINISHED");
      expect(result2.run.attemptNumber).toBe(2);
      expect(result2.run.status).toBe("COMPLETED_SUCCESSFULLY");

      //waitpoint should have been completed, with the output
      const runWaitpointAfter = await prisma.waitpoint.findMany({
        where: {
          completedByTaskRunId: run.id,
        },
      });
      expect(runWaitpointAfter.length).toBe(1);
      expect(runWaitpointAfter[0].type).toBe("RUN");
      expect(runWaitpointAfter[0].output).toBe(`{"foo":"bar"}`);
      expect(runWaitpointAfter[0].outputIsError).toBe(false);

      //state should be completed
      const executionData4 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData4);
      expect(executionData4.snapshot.executionStatus).toBe("FINISHED");
      expect(executionData4.run.attemptNumber).toBe(2);
      expect(executionData4.run.status).toBe("COMPLETED_SUCCESSFULLY");
    } finally {
      await engine.quit();
    }
  });

  containerTest("OOM fails after retrying on larger machine", async ({ prisma, redisOptions }) => {
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
          "small-2x": {
            name: "small-2x" as const,
            cpu: 1,
            memory: 1,
            centsPerMs: 0.0002,
          },
        },
        baseCostInCents: 0.0001,
      },
      tracer: trace.getTracer("test", "0.0.0"),
    });

    try {
      const taskIdentifier = "test-task";

      //create background worker
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier, undefined, {
        maxTimeoutInMs: 10,
        maxAttempts: 10,
        outOfMemory: {
          machine: "small-2x",
        },
      });

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
          queue: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );

      //dequeue the run
      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      //create first attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      //fail the first attempt with an OOM error
      const error = {
        type: "INTERNAL_ERROR" as const,
        code: "TASK_PROCESS_EXITED_WITH_NON_ZERO_CODE" as const,
        message: "Process exited with code -1 after signal SIGKILL.",
        stackTrace: "JavaScript heap out of memory",
      };

      const result = await engine.completeRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: attemptResult.snapshot.id,
        completion: {
          ok: false,
          id: dequeued[0].run.id,
          error,
        },
      });

      // The run should be retried with a larger machine
      expect(result.attemptStatus).toBe("RETRY_QUEUED");
      expect(result.snapshot.executionStatus).toBe("QUEUED");
      expect(result.run.status).toBe("RETRYING_AFTER_FAILURE");

      //state should be queued
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("QUEUED");
      expect(executionData.run.attemptNumber).toBe(1);
      expect(executionData.run.status).toBe("RETRYING_AFTER_FAILURE");

      //wait for 1s
      await setTimeout(5_000);

      //dequeue again
      const dequeued2 = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });
      expect(dequeued2.length).toBe(1);

      //create second attempt
      const attemptResult2 = await engine.startRunAttempt({
        runId: dequeued2[0].run.id,
        snapshotId: dequeued2[0].snapshot.id,
      });
      expect(attemptResult2.run.attemptNumber).toBe(2);

      //fail the second attempt with the same OOM error
      const result2 = await engine.completeRunAttempt({
        runId: dequeued2[0].run.id,
        snapshotId: attemptResult2.snapshot.id,
        completion: {
          ok: false,
          id: dequeued2[0].run.id,
          error,
          retry: {
            timestamp: Date.now(),
            delay: 0,
          },
        },
      });

      // The run should fail after the second OOM
      expect(result2.attemptStatus).toBe("RUN_FINISHED");
      expect(result2.snapshot.executionStatus).toBe("FINISHED");
      expect(result2.run.status).toBe("CRASHED");

      //final state should be crashed
      const finalExecutionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(finalExecutionData);
      expect(finalExecutionData.snapshot.executionStatus).toBe("FINISHED");
      expect(finalExecutionData.run.attemptNumber).toBe(2);
      expect(finalExecutionData.run.status).toBe("CRASHED");
    } finally {
      await engine.quit();
    }
  });
});
