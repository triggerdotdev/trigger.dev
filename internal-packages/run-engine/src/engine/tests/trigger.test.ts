import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { EventBusEventArgs } from "../eventBus.js";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { setTimeout } from "node:timers/promises";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine trigger()", () => {
  containerTest("Single run (success)", async ({ prisma, redisOptions }) => {
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
        baseCostInCents: 0.0005,
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
          workerQueue: "main",
          queue: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );
      expect(run).toBeDefined();
      expect(run.friendlyId).toBe("run_1234");

      //check it's actually in the db
      const runFromDb = await prisma.taskRun.findUnique({
        where: {
          friendlyId: "run_1234",
        },
      });
      expect(runFromDb).toBeDefined();
      expect(runFromDb?.id).toBe(run.id);

      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("QUEUED");

      //check the waitpoint is created
      const runWaitpoint = await prisma.waitpoint.findMany({
        where: {
          completedByTaskRunId: run.id,
        },
      });
      expect(runWaitpoint.length).toBe(1);
      expect(runWaitpoint[0].type).toBe("RUN");

      //check the queue length
      const queueLength = await engine.runQueue.lengthOfQueue(authenticatedEnvironment, run.queue);
      expect(queueLength).toBe(1);

      //concurrency before
      const envConcurrencyBefore = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );
      expect(envConcurrencyBefore).toBe(0);

      await setTimeout(500);

      //dequeue the run
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      expect(dequeued.length).toBe(1);
      expect(dequeued[0].run.id).toBe(run.id);
      expect(dequeued[0].run.attemptNumber).toBe(1);

      const envConcurrencyAfter = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );
      expect(envConcurrencyAfter).toBe(1);

      let attemptEvent: EventBusEventArgs<"runAttemptStarted">[0] | undefined = undefined;
      engine.eventBus.on("runAttemptStarted", (result) => {
        attemptEvent = result;
      });

      //create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });
      expect(attemptResult.run.id).toBe(run.id);
      expect(attemptResult.run.status).toBe("EXECUTING");
      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      //attempt event
      assertNonNullable(attemptEvent);
      const attemptedEvent = attemptEvent as EventBusEventArgs<"runAttemptStarted">[0];
      expect(attemptedEvent.run.id).toBe(run.id);
      expect(attemptedEvent.run.baseCostInCents).toBe(0.0005);

      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("EXECUTING");
      expect(executionData2.run.attemptNumber).toBe(1);
      expect(executionData2.run.status).toBe("EXECUTING");

      let successEvent: EventBusEventArgs<"runSucceeded">[0] | undefined = undefined;
      engine.eventBus.on("runSucceeded", (result) => {
        successEvent = result;
      });

      //complete the run
      const result = await engine.completeRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: attemptResult.snapshot.id,
        completion: {
          ok: true,
          id: dequeued[0].run.id,
          output: `{"foo":"bar"}`,
          outputType: "application/json",
        },
      });
      expect(result.attemptStatus).toBe("RUN_FINISHED");
      expect(result.snapshot.executionStatus).toBe("FINISHED");
      expect(result.run.attemptNumber).toBe(1);
      expect(result.run.status).toBe("COMPLETED_SUCCESSFULLY");

      //state should be completed
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("FINISHED");
      expect(executionData3.run.attemptNumber).toBe(1);
      expect(executionData3.run.status).toBe("COMPLETED_SUCCESSFULLY");

      //success event
      assertNonNullable(successEvent);
      const completedEvent = successEvent as EventBusEventArgs<"runSucceeded">[0];
      expect(completedEvent.run.spanId).toBe(run.spanId);
      expect(completedEvent.run.output).toBe('{"foo":"bar"}');
      expect(completedEvent.run.outputType).toBe("application/json");

      //concurrency should have been released
      const envConcurrencyCompleted = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );
      expect(envConcurrencyCompleted).toBe(0);

      //waitpoint should have been completed, with the output
      const runWaitpointAfter = await prisma.waitpoint.findMany({
        where: {
          completedByTaskRunId: run.id,
        },
      });
      expect(runWaitpointAfter.length).toBe(1);
      expect(runWaitpointAfter[0].type).toBe("RUN");
      expect(runWaitpointAfter[0].output).toBe(`{"foo":"bar"}`);
    } finally {
      await engine.quit();
    }
  });

  containerTest("Single run (failed)", async ({ prisma, redisOptions }) => {
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
        masterQueueConsumersDisabled: true,
        processWorkerQueueDebounceMs: 50,
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
          workerQueue: "main",
          queue: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );

      await setTimeout(500);

      //dequeue the run
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
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
        },
      });
      expect(result.attemptStatus).toBe("RUN_FINISHED");
      expect(result.snapshot.executionStatus).toBe("FINISHED");
      expect(result.run.attemptNumber).toBe(1);
      expect(result.run.status).toBe("COMPLETED_WITH_ERRORS");

      //state should be completed
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("FINISHED");
      expect(executionData3.run.attemptNumber).toBe(1);
      expect(executionData3.run.status).toBe("COMPLETED_WITH_ERRORS");

      //concurrency should have been released
      const envConcurrencyCompleted = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );
      expect(envConcurrencyCompleted).toBe(0);

      //waitpoint should have been completed, with the output
      const runWaitpointAfter = await prisma.waitpoint.findMany({
        where: {
          completedByTaskRunId: run.id,
        },
      });
      expect(runWaitpointAfter.length).toBe(1);
      expect(runWaitpointAfter[0].type).toBe("RUN");
      const output = JSON.parse(runWaitpointAfter[0].output as string);
      expect(output.type).toBe(error.type);
      expect(runWaitpointAfter[0].outputIsError).toBe(true);
    } finally {
      await engine.quit();
    }
  });
});
