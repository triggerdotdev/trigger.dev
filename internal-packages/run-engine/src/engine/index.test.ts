import {
  containerTest,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
} from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { expect } from "vitest";
import { RunEngine } from "./index.js";
import { setTimeout } from "timers/promises";
import { EventBusEventArgs } from "./eventBus.js";

function assertNonNullable<T>(value: T): asserts value is NonNullable<T> {
  expect(value).toBeDefined();
  expect(value).not.toBeNull();
}

describe("RunEngine", () => {
  containerTest("Single run (success)", { timeout: 15_000 }, async ({ prisma, redisContainer }) => {
    //create environment
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const engine = new RunEngine({
      prisma,
      redis: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
        enableAutoPipelining: true,
      },
      worker: {
        workers: 1,
        tasksPerWorker: 10,
        pollIntervalMs: 100,
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

      //dequeue the run
      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });
      expect(dequeued.length).toBe(1);
      expect(dequeued[0].run.id).toBe(run.id);
      expect(dequeued[0].run.attemptNumber).toBe(1);

      const envConcurrencyAfter = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );
      expect(envConcurrencyAfter).toBe(1);

      //create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].execution.id,
      });
      expect(attemptResult.run.id).toBe(run.id);
      expect(attemptResult.run.status).toBe("EXECUTING");
      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("EXECUTING");
      expect(executionData2.run.attemptNumber).toBe(1);
      expect(executionData2.run.status).toBe("EXECUTING");

      let event: EventBusEventArgs<"runSucceeded">[0] | undefined = undefined;
      engine.eventBus.on("runSucceeded", (result) => {
        event = result;
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
      expect(result).toBe("COMPLETED");

      //state should be completed
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("FINISHED");
      expect(executionData3.run.attemptNumber).toBe(1);
      expect(executionData3.run.status).toBe("COMPLETED_SUCCESSFULLY");

      //event
      assertNonNullable(event);
      const completedEvent = event as EventBusEventArgs<"runSucceeded">[0];
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
      engine.quit();
    }
  });

  containerTest("Single run (failed)", { timeout: 15_000 }, async ({ prisma, redisContainer }) => {
    //create environment
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const engine = new RunEngine({
      prisma,
      redis: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
        enableAutoPipelining: true,
      },
      worker: {
        workers: 1,
        tasksPerWorker: 10,
        pollIntervalMs: 100,
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
        snapshotId: dequeued[0].execution.id,
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
      expect(result).toBe("COMPLETED");

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
      engine.quit();
    }
  });

  containerTest(
    "Single run (retry attempt, then succeed)",
    { timeout: 15_000 },
    async ({ prisma, redisContainer }) => {
      //create environment
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        redis: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
          enableAutoPipelining: true,
        },
        worker: {
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
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
          snapshotId: dequeued[0].execution.id,
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
        expect(result).toBe("RETRY_IMMEDIATELY");

        //state should be completed
        const executionData3 = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData3);
        expect(executionData3.snapshot.executionStatus).toBe("EXECUTING");
        expect(executionData3.run.attemptNumber).toBe(2);
        expect(executionData3.run.status).toBe("RETRYING_AFTER_FAILURE");

        //now complete it successfully
        const result2 = await engine.completeRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: executionData3.snapshot.id,
          completion: {
            ok: true,
            id: dequeued[0].run.id,
            output: `{"foo":"bar"}`,
            outputType: "application/json",
          },
        });

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
        engine.quit();
      }
    }
  );

  containerTest("triggerAndWait", { timeout: 15_000 }, async ({ prisma, redisContainer }) => {
    //create environment
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const engine = new RunEngine({
      prisma,
      redis: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
        enableAutoPipelining: true,
      },
      worker: {
        workers: 1,
        tasksPerWorker: 10,
        pollIntervalMs: 100,
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
          queueName: `task/${parentTask}`,
          isTest: false,
          tags: [],
        },
        prisma
      );

      //dequeue parent
      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: parentRun.masterQueue,
        maxRunCount: 10,
      });

      //create an attempt
      const initialExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
      assertNonNullable(initialExecutionData);
      const attemptResult = await engine.startRunAttempt({
        runId: parentRun.id,
        snapshotId: initialExecutionData.snapshot.id,
      });

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
          queueName: `task/${childTask}`,
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

      //check the waitpoint blocking the parent run
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
      expect(runWaitpoint.waitpoint.completedByTaskRunId).toBe(childRun.id);

      // complete the child run
      await engine.completeRunAttempt({
        runId: childRun.id,
        snapshotId: childExecutionData.snapshot.id,
        completion: {
          id: childRun.id,
          ok: true,
          output: '{"foo":"bar"}',
          outputType: "application/json",
        },
      });

      //child snapshot
      const childExecutionDataAfter = await engine.getRunExecutionData({ runId: childRun.id });
      assertNonNullable(childExecutionDataAfter);
      expect(childExecutionDataAfter.snapshot.executionStatus).toBe("FINISHED");

      const waitpointAfter = await prisma.waitpoint.findFirst({
        where: {
          id: runWaitpoint.waitpointId,
        },
      });
      expect(waitpointAfter?.completedAt).not.toBeNull();
      expect(waitpointAfter?.status).toBe("COMPLETED");
      expect(waitpointAfter?.output).toBe('{"foo":"bar"}');

      const runWaitpointAfter = await prisma.taskRunWaitpoint.findFirst({
        where: {
          taskRunId: parentRun.id,
        },
        include: {
          waitpoint: true,
        },
      });
      expect(runWaitpointAfter).toBeNull();

      //parent snapshot
      const parentExecutionDataAfter = await engine.getRunExecutionData({ runId: parentRun.id });
      assertNonNullable(parentExecutionDataAfter);
      expect(parentExecutionDataAfter.snapshot.executionStatus).toBe("EXECUTING");
      expect(parentExecutionDataAfter.completedWaitpoints?.length).toBe(1);
      expect(parentExecutionDataAfter.completedWaitpoints![0].id).toBe(runWaitpoint.waitpointId);
      expect(parentExecutionDataAfter.completedWaitpoints![0].completedByTaskRunId).toBe(
        childRun.id
      );
      expect(parentExecutionDataAfter.completedWaitpoints![0].output).toBe('{"foo":"bar"}');
    } finally {
      engine.quit();
    }
  });

  containerTest("waitForDuration", { timeout: 15_000 }, async ({ prisma, redisContainer }) => {
    //create environment
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const engine = new RunEngine({
      prisma,
      redis: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
        enableAutoPipelining: true,
      },
      worker: {
        workers: 1,
        tasksPerWorker: 10,
        pollIntervalMs: 100,
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
      await setupBackgroundWorker(prisma, authenticatedEnvironment, taskIdentifier);

      //trigger the run
      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_p1234",
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
        snapshotId: dequeued[0].execution.id,
      });
      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      //waitForDuration
      const date = new Date(Date.now() + 1000);
      const result = await engine.waitForDuration({
        runId: run.id,
        snapshotId: attemptResult.snapshot.id,
        date,
        releaseConcurrency: false,
      });

      expect(result.willWaitUntil.toISOString()).toBe(date.toISOString());

      const executionData = await engine.getRunExecutionData({ runId: run.id });
      expect(executionData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      await setTimeout(1_500);

      const executionDataAfter = await engine.getRunExecutionData({ runId: run.id });
      expect(executionDataAfter?.snapshot.executionStatus).toBe("EXECUTING");
    } finally {
      engine.quit();
    }
  });

  //todo batchTriggerAndWait

  //todo checkpoints

  //todo heartbeats

  //todo failing a run

  //todo cancelling a run

  //todo crashed run

  //todo system failure run

  //todo delaying a run
  containerTest("Run delayed", { timeout: 15_000 }, async ({ prisma, redisContainer }) => {
    //create environment
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const engine = new RunEngine({
      prisma,
      redis: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
        enableAutoPipelining: true,
      },
      worker: {
        workers: 1,
        tasksPerWorker: 10,
        pollIntervalMs: 100,
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

  //todo expiring a run
  containerTest("Run expiring (ttl)", { timeout: 15_000 }, async ({ prisma, redisContainer }) => {
    //create environment
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const engine = new RunEngine({
      prisma,
      redis: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
        enableAutoPipelining: true,
      },
      worker: {
        workers: 1,
        tasksPerWorker: 10,
        pollIntervalMs: 100,
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
          ttl: "1s",
        },
        prisma
      );

      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("QUEUED");

      let expiredEventData: EventBusEventArgs<"runExpired">[0] | undefined = undefined;
      engine.eventBus.on("runExpired", (result) => {
        expiredEventData = result;
      });

      //wait for 1 seconds
      await setTimeout(1_000);

      assertNonNullable(expiredEventData);
      const assertedExpiredEventData = expiredEventData as EventBusEventArgs<"runExpired">[0];
      expect(assertedExpiredEventData.run.spanId).toBe(run.spanId);

      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("FINISHED");
      expect(executionData2.run.attemptNumber).toBe(undefined);
      expect(executionData2.run.status).toBe("EXPIRED");
    } finally {
      engine.quit();
    }
  });
});
