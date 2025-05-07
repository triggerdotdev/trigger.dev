import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "node:timers/promises";
import { EventBusEventArgs } from "../eventBus.js";
import { isWaitpointOutputTimeout } from "@trigger.dev/core/v3";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine Waitpoints", () => {
  containerTest("waitForDuration", async ({ prisma, redisOptions }) => {
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
      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      const durationMs = 1_000;

      //waitForDuration
      const date = new Date(Date.now() + durationMs);
      const { waitpoint } = await engine.createDateTimeWaitpoint({
        projectId: authenticatedEnvironment.project.id,
        environmentId: authenticatedEnvironment.id,
        completedAfter: date,
      });
      expect(waitpoint.completedAfter!.toISOString()).toBe(date.toISOString());

      const result = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: [waitpoint.id],
        projectId: authenticatedEnvironment.project.id,
        organizationId: authenticatedEnvironment.organization.id,
        releaseConcurrency: true,
      });
      expect(result.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
      expect(result.runStatus).toBe("EXECUTING");

      const executionData = await engine.getRunExecutionData({ runId: run.id });
      expect(executionData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      await setTimeout(2_000);

      const waitpoint2 = await prisma.waitpoint.findFirst({
        where: {
          id: waitpoint.id,
        },
      });
      expect(waitpoint2?.status).toBe("COMPLETED");
      expect(waitpoint2?.completedAt?.getTime()).toBeLessThanOrEqual(date.getTime() + 200);

      const executionDataAfter = await engine.getRunExecutionData({ runId: run.id });
      expect(executionDataAfter?.snapshot.executionStatus).toBe("EXECUTING");
    } finally {
      await engine.quit();
    }
  });

  containerTest("Waitpoints cleared if attempt fails", async ({ prisma, redisOptions }) => {
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
      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      //waitForDuration
      const date = new Date(Date.now() + 60_000);
      const { waitpoint } = await engine.createDateTimeWaitpoint({
        projectId: authenticatedEnvironment.project.id,
        environmentId: authenticatedEnvironment.id,
        completedAfter: date,
      });
      expect(waitpoint.completedAfter!.toISOString()).toBe(date.toISOString());

      const result = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: [waitpoint.id],
        projectId: authenticatedEnvironment.project.id,
        organizationId: authenticatedEnvironment.organization.id,
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
      expect(failResult.snapshot.executionStatus).toBe("EXECUTING");
      expect(failResult.run.attemptNumber).toBe(1);
      expect(failResult.run.status).toBe("RETRYING_AFTER_FAILURE");

      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("EXECUTING");
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
      await engine.quit();
    }
  });

  containerTest(
    "Create, block, and complete a Manual waitpoint",
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
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

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
        expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

        //create a manual waitpoint
        const result = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });
        expect(result.waitpoint.status).toBe("PENDING");

        //block the run
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: result.waitpoint.id,
          projectId: authenticatedEnvironment.projectId,
          organizationId: authenticatedEnvironment.organizationId,
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
        expect(runWaitpointBefore?.waitpointId).toBe(result.waitpoint.id);

        let event: EventBusEventArgs<"workerNotification">[0] | undefined = undefined;
        engine.eventBus.on("workerNotification", (result) => {
          event = result;
        });

        //complete the waitpoint
        await engine.completeWaitpoint({
          id: result.waitpoint.id,
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
        await engine.quit();
      }
    }
  );

  containerTest("Manual waitpoint failAfter", async ({ prisma, redisOptions }) => {
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
      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      //create a manual waitpoint
      const result = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
        //fail after 200ms
        timeout: new Date(Date.now() + 200),
      });

      //block the run
      await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: result.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
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
      await engine.quit();
    }
  });

  containerTest(
    "Race condition with multiple waitpoints completing simultaneously",
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
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

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
        expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

        const iterationCount = 10;

        for (let i = 0; i < iterationCount; i++) {
          const waitpointCount = 5;

          //create waitpoints
          const results = await Promise.all(
            Array.from({ length: waitpointCount }).map(() =>
              engine.createManualWaitpoint({
                environmentId: authenticatedEnvironment.id,
                projectId: authenticatedEnvironment.projectId,
              })
            )
          );

          //block the run with them
          await Promise.all(
            results.map((result) =>
              engine.blockRunWithWaitpoint({
                runId: run.id,
                waitpoints: result.waitpoint.id,
                projectId: authenticatedEnvironment.projectId,
                organizationId: authenticatedEnvironment.organizationId,
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
            results.map((result) =>
              engine.completeWaitpoint({
                id: result.waitpoint.id,
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
        await engine.quit();
      }
    }
  );

  containerTest(
    "Create a Manual waitpoint and let it timeout",
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
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

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
        expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

        //create a manual waitpoint with timeout
        const timeout = new Date(Date.now() + 1_000);
        const result = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
          timeout,
        });
        expect(result.waitpoint.status).toBe("PENDING");
        expect(result.waitpoint.completedAfter).toStrictEqual(timeout);

        //block the run
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: result.waitpoint.id,
          projectId: authenticatedEnvironment.projectId,
          organizationId: authenticatedEnvironment.organizationId,
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
        expect(runWaitpointBefore?.waitpointId).toBe(result.waitpoint.id);

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
            id: result.waitpoint.id,
          },
        });
        assertNonNullable(waitpoint2);
        expect(waitpoint2.status).toBe("COMPLETED");
        expect(waitpoint2.outputIsError).toBe(true);
        assertNonNullable(waitpoint2.output);
        const isTimeout = isWaitpointOutputTimeout(waitpoint2.output);
        expect(isTimeout).toBe(true);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("Manual waitpoint with idempotency", async ({ prisma, redisOptions }) => {
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
      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      const idempotencyKey = "a-key";

      //create a manual waitpoint with timeout
      const result = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
        idempotencyKey,
      });
      expect(result.waitpoint.status).toBe("PENDING");
      expect(result.waitpoint.idempotencyKey).toBe(idempotencyKey);
      expect(result.waitpoint.userProvidedIdempotencyKey).toBe(true);

      //block the run
      await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: result.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
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
      expect(runWaitpointBefore?.waitpointId).toBe(result.waitpoint.id);

      let event: EventBusEventArgs<"workerNotification">[0] | undefined = undefined;
      engine.eventBus.on("workerNotification", (result) => {
        event = result;
      });

      //complete the waitpoint
      await engine.completeWaitpoint({
        id: result.waitpoint.id,
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
          id: result.waitpoint.id,
        },
      });
      assertNonNullable(waitpoint2);
      expect(waitpoint2.status).toBe("COMPLETED");
      expect(waitpoint2.outputIsError).toBe(false);
    } finally {
      await engine.quit();
    }
  });

  containerTest("Manual waitpoint with idempotency and ttl", async ({ prisma, redisOptions }) => {
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
      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      const idempotencyKey = "a-key";

      //create a manual waitpoint with timeout
      const result = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
        idempotencyKey,
        idempotencyKeyExpiresAt: new Date(Date.now() + 200),
      });
      expect(result.waitpoint.status).toBe("PENDING");
      expect(result.waitpoint.idempotencyKey).toBe(idempotencyKey);
      expect(result.waitpoint.userProvidedIdempotencyKey).toBe(true);

      const sameWaitpointResult = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
        idempotencyKey,
        idempotencyKeyExpiresAt: new Date(Date.now() + 200),
      });
      expect(sameWaitpointResult.waitpoint.id).toBe(result.waitpoint.id);

      //block the run
      await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: result.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
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
      expect(runWaitpointBefore?.waitpointId).toBe(result.waitpoint.id);

      let event: EventBusEventArgs<"workerNotification">[0] | undefined = undefined;
      engine.eventBus.on("workerNotification", (result) => {
        event = result;
      });

      //complete the waitpoint
      await engine.completeWaitpoint({
        id: result.waitpoint.id,
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
          id: result.waitpoint.id,
        },
      });
      assertNonNullable(waitpoint2);
      expect(waitpoint2.status).toBe("COMPLETED");
      expect(waitpoint2.outputIsError).toBe(false);
    } finally {
      await engine.quit();
    }
  });

  containerTest(
    "continueRunIfUnblocked enqueues run when cannot reacquire concurrency",
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
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        // Create background worker
        await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier,
          undefined,
          undefined,
          {
            concurrencyLimit: 1,
          }
        );

        // Create first run with queue concurrency limit of 1
        const firstRun = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_first",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345-first",
            spanId: "s12345-first",
            masterQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        // Dequeue and start the first run
        const dequeuedFirst = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: firstRun.masterQueue,
          maxRunCount: 10,
        });

        const firstAttempt = await engine.startRunAttempt({
          runId: dequeuedFirst[0].run.id,
          snapshotId: dequeuedFirst[0].snapshot.id,
        });
        expect(firstAttempt.snapshot.executionStatus).toBe("EXECUTING");

        // Create a manual waitpoint for the first run
        const waitpoint = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });
        expect(waitpoint.waitpoint.status).toBe("PENDING");

        // Block the first run with releaseConcurrency set to true
        const blockedResult = await engine.blockRunWithWaitpoint({
          runId: firstRun.id,
          waitpoints: waitpoint.waitpoint.id,
          projectId: authenticatedEnvironment.projectId,
          organizationId: authenticatedEnvironment.organizationId,
          releaseConcurrency: true,
        });

        // Verify first run is blocked
        const firstRunData = await engine.getRunExecutionData({ runId: firstRun.id });
        expect(firstRunData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        // Create and start second run on the same queue
        const secondRun = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_second",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345-second",
            spanId: "s12345-second",
            masterQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        // Dequeue and start the second run
        const dequeuedSecond = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: secondRun.masterQueue,
          maxRunCount: 10,
        });

        const secondAttempt = await engine.startRunAttempt({
          runId: dequeuedSecond[0].run.id,
          snapshotId: dequeuedSecond[0].snapshot.id,
        });
        expect(secondAttempt.snapshot.executionStatus).toBe("EXECUTING");

        // Now complete the waitpoint for the first run
        await engine.completeWaitpoint({
          id: waitpoint.waitpoint.id,
        });

        // Wait for the continueRunIfUnblocked to process
        await setTimeout(500);

        // Verify the first run is now in QUEUED_EXECUTING state
        const executionDataAfter = await engine.getRunExecutionData({ runId: firstRun.id });
        expect(executionDataAfter?.snapshot.executionStatus).toBe("QUEUED_EXECUTING");
        expect(executionDataAfter?.snapshot.description).toBe(
          "Run can continue, but is waiting for concurrency"
        );

        // Verify the waitpoint is no longer blocking the first run
        const runWaitpoint = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: firstRun.id,
          },
          include: {
            waitpoint: true,
          },
        });
        expect(runWaitpoint).toBeNull();

        // Verify the waitpoint itself is completed
        const completedWaitpoint = await prisma.waitpoint.findUnique({
          where: {
            id: waitpoint.waitpoint.id,
          },
        });
        assertNonNullable(completedWaitpoint);
        expect(completedWaitpoint.status).toBe("COMPLETED");

        // Complete the second run so the first run can be dequeued
        const result = await engine.completeRunAttempt({
          runId: dequeuedSecond[0].run.id,
          snapshotId: secondAttempt.snapshot.id,
          completion: {
            ok: true,
            id: dequeuedSecond[0].run.id,
            output: `{"foo":"bar"}`,
            outputType: "application/json",
          },
        });

        await setTimeout(500);

        let event: EventBusEventArgs<"workerNotification">[0] | undefined = undefined;
        engine.eventBus.on("workerNotification", (result) => {
          event = result;
        });

        // Verify the first run is back in the queue
        const queuedRun = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: firstRun.masterQueue,
          maxRunCount: 10,
        });

        expect(queuedRun.length).toBe(0);

        // Get the latest execution snapshot and make sure it's EXECUTING
        const executionData = await engine.getRunExecutionData({ runId: firstRun.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("EXECUTING");

        assertNonNullable(event);
        const notificationEvent = event as EventBusEventArgs<"workerNotification">[0];
        expect(notificationEvent.run.id).toBe(firstRun.id);
        expect(notificationEvent.snapshot.executionStatus).toBe("EXECUTING");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "getSnapshotsSince returns correct snapshots and handles errors",
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
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_snapshotsince",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_snapshotsince",
            spanId: "s_snapshotsince",
            masterQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        // Dequeue and start the run (snapshot 1)
        const dequeued = await engine.dequeueFromMasterQueue({
          consumerId: "test_snapshotsince",
          masterQueue: run.masterQueue,
          maxRunCount: 10,
        });
        const attemptResult = await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        // Block the run with a waitpoint (snapshot 2)
        const { waitpoint } = await engine.createDateTimeWaitpoint({
          projectId: authenticatedEnvironment.project.id,
          environmentId: authenticatedEnvironment.id,
          completedAfter: new Date(Date.now() + 100),
        });
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: [waitpoint.id],
          projectId: authenticatedEnvironment.project.id,
          organizationId: authenticatedEnvironment.organization.id,
          releaseConcurrency: true,
        });

        // Wait for the waitpoint to complete and unblock (snapshot 3)
        await setTimeout(200);
        await engine.completeWaitpoint({ id: waitpoint.id });
        await setTimeout(200);

        // Get all snapshots for the run
        const allSnapshots = await prisma.taskRunExecutionSnapshot.findMany({
          where: { runId: run.id, isValid: true },
          orderBy: { createdAt: "asc" },
        });
        expect(allSnapshots.length).toBeGreaterThanOrEqual(3);

        // getSnapshotsSince with the first snapshot should return at least 2
        const sinceFirst = await engine.getSnapshotsSince({
          runId: run.id,
          snapshotId: allSnapshots[0].id,
        });
        assertNonNullable(sinceFirst);
        expect(sinceFirst.length).toBeGreaterThanOrEqual(2);

        // Check completedWaitpoints for each returned snapshot
        for (const snap of sinceFirst) {
          expect(Array.isArray(snap.completedWaitpoints)).toBe(true);
        }

        // At least one snapshot should have a completed waitpoint
        expect(sinceFirst.some((snap) => snap.completedWaitpoints.length === 1)).toBe(true);

        // If any completedWaitpoints exist, check output is not an error
        const withCompleted = sinceFirst.find((snap) => snap.completedWaitpoints.length === 1);
        if (withCompleted) {
          expect(withCompleted.completedWaitpoints[0].outputIsError).toBe(false);
        }

        // getSnapshotsSince with the latest snapshot should return 0
        const sinceLatest = await engine.getSnapshotsSince({
          runId: run.id,
          snapshotId: allSnapshots[allSnapshots.length - 1].id,
        });
        assertNonNullable(sinceLatest);
        expect(sinceLatest.length).toBe(0);

        // getSnapshotsSince with an invalid snapshotId should throw or return []
        let threw = false;
        try {
          const sinceInvalid = await engine.getSnapshotsSince({
            runId: run.id,
            snapshotId: "invalid-id",
          });
          expect(sinceInvalid).toBeNull();
        } catch (e) {
          threw = true;
        }
        // should never throw
        expect(threw).toBe(false);
      } finally {
        await engine.quit();
      }
    }
  );
});
