import {
  assertNonNullable,
  containerTest,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
} from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";
import { EventBusEventArgs } from "../eventBus.js";
import { isWaitpointOutputTimeout } from "@trigger.dev/core/v3";

describe("RunEngine Waitpoints", () => {
  containerTest("waitForDuration", { timeout: 15_000 }, async ({ prisma, redisOptions }) => {
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
        snapshotId: dequeued[0].snapshot.id,
      });
      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      const durationMs = 1_000;

      //waitForDuration
      const date = new Date(Date.now() + durationMs);
      const result = await engine.waitForDuration({
        runId: run.id,
        snapshotId: attemptResult.snapshot.id,
        date,
        releaseConcurrency: false,
      });
      expect(result.waitUntil.toISOString()).toBe(date.toISOString());
      expect(result.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
      expect(result.run.status).toBe("EXECUTING");

      const executionData = await engine.getRunExecutionData({ runId: run.id });
      expect(executionData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      await setTimeout(2_000);

      const waitpoint = await prisma.waitpoint.findFirst({
        where: {
          id: result.waitpoint.id,
        },
      });
      expect(waitpoint?.status).toBe("COMPLETED");
      expect(waitpoint?.completedAt?.getTime()).toBeLessThanOrEqual(date.getTime() + 200);

      const executionDataAfter = await engine.getRunExecutionData({ runId: run.id });
      expect(executionDataAfter?.snapshot.executionStatus).toBe("EXECUTING");
    } finally {
      engine.quit();
    }
  });

  containerTest(
    "Waitpoints cleared if attempt fails",
    { timeout: 15_000 },
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
          snapshotId: dequeued[0].snapshot.id,
        });
        expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

        //waitForDuration
        const date = new Date(Date.now() + 60_000);
        const result = await engine.waitForDuration({
          runId: run.id,
          snapshotId: attemptResult.snapshot.id,
          date,
          releaseConcurrency: false,
        });

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        expect(executionData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        //fail the attempt (user error)
        const error = {
          type: "BUILT_IN_ERROR" as const,
          name: "UserError",
          message: "This is a user error",
          stackTrace: "Error: This is a user error\n    at <anonymous>:1:1",
        };
        const failResult = await engine.completeRunAttempt({
          runId: executionData!.run.id,
          snapshotId: executionData!.snapshot.id,
          completion: {
            ok: false,
            id: executionData!.run.id,
            error,
            retry: {
              timestamp: Date.now(),
              delay: 0,
            },
          },
        });
        expect(failResult.attemptStatus).toBe("RETRY_IMMEDIATELY");
        expect(failResult.snapshot.executionStatus).toBe("PENDING_EXECUTING");
        expect(failResult.run.attemptNumber).toBe(1);
        expect(failResult.run.status).toBe("RETRYING_AFTER_FAILURE");

        const executionData2 = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData2);
        expect(executionData2.snapshot.executionStatus).toBe("PENDING_EXECUTING");
        expect(executionData2.run.attemptNumber).toBe(1);
        expect(executionData2.run.status).toBe("RETRYING_AFTER_FAILURE");
        expect(executionData2.completedWaitpoints.length).toBe(0);

        //check there are no waitpoints blocking the parent run
        const runWaitpoint = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: run.id,
          },
          include: {
            waitpoint: true,
          },
        });
        expect(runWaitpoint).toBeNull();
      } finally {
        engine.quit();
      }
    }
  );

  containerTest(
    "Create, block, and complete a Manual waitpoint",
    { timeout: 15_000 },
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
          snapshotId: dequeued[0].snapshot.id,
        });
        expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

        //create a manual waitpoint
        const waitpoint = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });
        expect(waitpoint.status).toBe("PENDING");

        //block the run
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.id,
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        expect(executionData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        //check there is a waitpoint blocking the parent run
        const runWaitpointBefore = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: run.id,
          },
          include: {
            waitpoint: true,
          },
        });
        expect(runWaitpointBefore?.waitpointId).toBe(waitpoint.id);

        let event: EventBusEventArgs<"workerNotification">[0] | undefined = undefined;
        engine.eventBus.on("workerNotification", (result) => {
          event = result;
        });

        //complete the waitpoint
        await engine.completeWaitpoint({
          id: waitpoint.id,
        });

        await setTimeout(200);

        assertNonNullable(event);
        const notificationEvent = event as EventBusEventArgs<"workerNotification">[0];
        expect(notificationEvent.run.id).toBe(run.id);

        const executionData2 = await engine.getRunExecutionData({ runId: run.id });
        expect(executionData2?.snapshot.executionStatus).toBe("EXECUTING");

        //check there are no waitpoints blocking the parent run
        const runWaitpoint = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: run.id,
          },
          include: {
            waitpoint: true,
          },
        });
        expect(runWaitpoint).toBeNull();
      } finally {
        engine.quit();
      }
    }
  );

  containerTest(
    "Manual waitpoint failAfter",
    { timeout: 15_000 },
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
          snapshotId: dequeued[0].snapshot.id,
        });
        expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

        //create a manual waitpoint
        const waitpoint = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });

        //block the run
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.id,
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
          //fail after 200ms
          failAfter: new Date(Date.now() + 200),
        });

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        expect(executionData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        await setTimeout(750);

        const executionData2 = await engine.getRunExecutionData({ runId: run.id });
        expect(executionData2?.snapshot.executionStatus).toBe("EXECUTING");
        expect(executionData2?.completedWaitpoints.length).toBe(1);
        expect(executionData2?.completedWaitpoints[0].outputIsError).toBe(true);

        //check there are no waitpoints blocking the parent run
        const runWaitpoint = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: run.id,
          },
          include: {
            waitpoint: true,
          },
        });
        expect(runWaitpoint).toBeNull();
      } finally {
        engine.quit();
      }
    }
  );

  containerTest(
    "Race condition with multiple waitpoints completing simultaneously",
    { timeout: 60_000 },
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
          snapshotId: dequeued[0].snapshot.id,
        });
        expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

        const iterationCount = 10;

        for (let i = 0; i < iterationCount; i++) {
          const waitpointCount = 5;

          //create waitpoints
          const waitpoints = await Promise.all(
            Array.from({ length: waitpointCount }).map(() =>
              engine.createManualWaitpoint({
                environmentId: authenticatedEnvironment.id,
                projectId: authenticatedEnvironment.projectId,
              })
            )
          );

          //block the run with them
          await Promise.all(
            waitpoints.map((waitpoint) =>
              engine.blockRunWithWaitpoint({
                runId: run.id,
                waitpoints: waitpoint.id,
                environmentId: authenticatedEnvironment.id,
                projectId: authenticatedEnvironment.projectId,
              })
            )
          );

          const executionData = await engine.getRunExecutionData({ runId: run.id });
          expect(executionData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

          //check there is a waitpoint blocking the parent run
          const runWaitpointsBefore = await prisma.taskRunWaitpoint.findMany({
            where: {
              taskRunId: run.id,
            },
            include: {
              waitpoint: true,
            },
          });
          expect(runWaitpointsBefore.length).toBe(waitpointCount);

          //complete the waitpoints
          await Promise.all(
            waitpoints.map((waitpoint) =>
              engine.completeWaitpoint({
                id: waitpoint.id,
              })
            )
          );

          await setTimeout(500);

          //expect the run to be executing again
          const executionData2 = await engine.getRunExecutionData({ runId: run.id });
          expect(executionData2?.snapshot.executionStatus).toBe("EXECUTING");

          //check there are no waitpoints blocking the parent run
          const runWaitpoints = await prisma.taskRunWaitpoint.findMany({
            where: {
              taskRunId: run.id,
            },
            include: {
              waitpoint: true,
            },
          });
          expect(runWaitpoints.length).toBe(0);
        }
      } finally {
        engine.quit();
      }
    }
  );

  containerTest(
    "Create a Manual waitpoint and let it timeout",
    { timeout: 15_000 },
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
          snapshotId: dequeued[0].snapshot.id,
        });
        expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

        //create a manual waitpoint with timeout
        const timeout = new Date(Date.now() + 1_000);
        const waitpoint = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
          timeout,
        });
        expect(waitpoint.status).toBe("PENDING");
        expect(waitpoint.completedAfter).toStrictEqual(timeout);

        //block the run
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.id,
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        expect(executionData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        //check there is a waitpoint blocking the parent run
        const runWaitpointBefore = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: run.id,
          },
          include: {
            waitpoint: true,
          },
        });
        expect(runWaitpointBefore?.waitpointId).toBe(waitpoint.id);

        let event: EventBusEventArgs<"workerNotification">[0] | undefined = undefined;
        engine.eventBus.on("workerNotification", (result) => {
          event = result;
        });

        await setTimeout(1_250);

        const executionData2 = await engine.getRunExecutionData({ runId: run.id });
        expect(executionData2?.snapshot.executionStatus).toBe("EXECUTING");

        assertNonNullable(event);
        const notificationEvent = event as EventBusEventArgs<"workerNotification">[0];
        expect(notificationEvent.run.id).toBe(run.id);

        //check there are no waitpoints blocking the parent run
        const runWaitpoint = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: run.id,
          },
          include: {
            waitpoint: true,
          },
        });
        expect(runWaitpoint).toBeNull();

        const waitpoint2 = await prisma.waitpoint.findUnique({
          where: {
            id: waitpoint.id,
          },
        });
        assertNonNullable(waitpoint2);
        expect(waitpoint2.status).toBe("COMPLETED");
        expect(waitpoint2.outputIsError).toBe(true);
        assertNonNullable(waitpoint2.output);
        const isTimeout = isWaitpointOutputTimeout(waitpoint2.output);
        expect(isTimeout).toBe(true);
      } finally {
        engine.quit();
      }
    }
  );

  containerTest(
    "Manual waitpoint with idempotency",
    { timeout: 15_000 },
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
          snapshotId: dequeued[0].snapshot.id,
        });
        expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

        const idempotencyKey = "a-key";

        //create a manual waitpoint with timeout
        const waitpoint = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
          idempotencyKey,
        });
        expect(waitpoint.status).toBe("PENDING");
        expect(waitpoint.idempotencyKey).toBe(idempotencyKey);
        expect(waitpoint.userProvidedIdempotencyKey).toBe(true);

        //block the run
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.id,
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        expect(executionData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        //check there is a waitpoint blocking the parent run
        const runWaitpointBefore = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: run.id,
          },
          include: {
            waitpoint: true,
          },
        });
        expect(runWaitpointBefore?.waitpointId).toBe(waitpoint.id);

        let event: EventBusEventArgs<"workerNotification">[0] | undefined = undefined;
        engine.eventBus.on("workerNotification", (result) => {
          event = result;
        });

        //complete the waitpoint
        await engine.completeWaitpoint({
          id: waitpoint.id,
        });

        await setTimeout(200);

        const executionData2 = await engine.getRunExecutionData({ runId: run.id });
        expect(executionData2?.snapshot.executionStatus).toBe("EXECUTING");

        assertNonNullable(event);
        const notificationEvent = event as EventBusEventArgs<"workerNotification">[0];
        expect(notificationEvent.run.id).toBe(run.id);

        //check there are no waitpoints blocking the parent run
        const runWaitpoint = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: run.id,
          },
          include: {
            waitpoint: true,
          },
        });
        expect(runWaitpoint).toBeNull();

        const waitpoint2 = await prisma.waitpoint.findUnique({
          where: {
            id: waitpoint.id,
          },
        });
        assertNonNullable(waitpoint2);
        expect(waitpoint2.status).toBe("COMPLETED");
        expect(waitpoint2.outputIsError).toBe(false);
      } finally {
        engine.quit();
      }
    }
  );

  containerTest(
    "Manual waitpoint with idempotency and ttl",
    { timeout: 15_000 },
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
          snapshotId: dequeued[0].snapshot.id,
        });
        expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

        const idempotencyKey = "a-key";

        //create a manual waitpoint with timeout
        const waitpoint = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
          idempotencyKey,
          idempotencyKeyExpiresAt: new Date(Date.now() + 200),
        });
        expect(waitpoint.status).toBe("PENDING");
        expect(waitpoint.idempotencyKey).toBe(idempotencyKey);
        expect(waitpoint.userProvidedIdempotencyKey).toBe(true);

        const sameWaitpoint = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
          idempotencyKey,
          idempotencyKeyExpiresAt: new Date(Date.now() + 200),
        });
        expect(sameWaitpoint.id).toBe(waitpoint.id);

        //block the run
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.id,
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        expect(executionData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        //check there is a waitpoint blocking the parent run
        const runWaitpointBefore = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: run.id,
          },
          include: {
            waitpoint: true,
          },
        });
        expect(runWaitpointBefore?.waitpointId).toBe(waitpoint.id);

        let event: EventBusEventArgs<"workerNotification">[0] | undefined = undefined;
        engine.eventBus.on("workerNotification", (result) => {
          event = result;
        });

        //complete the waitpoint
        await engine.completeWaitpoint({
          id: waitpoint.id,
        });

        await setTimeout(200);

        const executionData2 = await engine.getRunExecutionData({ runId: run.id });
        expect(executionData2?.snapshot.executionStatus).toBe("EXECUTING");

        assertNonNullable(event);
        const notificationEvent = event as EventBusEventArgs<"workerNotification">[0];
        expect(notificationEvent.run.id).toBe(run.id);

        //check there are no waitpoints blocking the parent run
        const runWaitpoint = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: run.id,
          },
          include: {
            waitpoint: true,
          },
        });
        expect(runWaitpoint).toBeNull();

        const waitpoint2 = await prisma.waitpoint.findUnique({
          where: {
            id: waitpoint.id,
          },
        });
        assertNonNullable(waitpoint2);
        expect(waitpoint2.status).toBe("COMPLETED");
        expect(waitpoint2.outputIsError).toBe(false);
      } finally {
        engine.quit();
      }
    }
  );
});
