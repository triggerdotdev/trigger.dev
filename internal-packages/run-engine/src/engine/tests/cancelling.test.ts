import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";
import { EventBusEventArgs } from "../eventBus.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine cancelling", () => {
  containerTest(
    "Cancelling a run with children (that is executing)",
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
        await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

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
            queue: `task/${parentTask}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        //dequeue the run
        const dequeued = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: parentRun.masterQueue,
          maxRunCount: 10,
        });

        //create an attempt
        const attemptResult = await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });
        expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

        //start child run
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
            queue: `task/${childTask}`,
            isTest: false,
            tags: [],
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun.id,
          },
          prisma
        );

        //dequeue the child run
        const dequeuedChild = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: childRun.masterQueue,
          maxRunCount: 10,
        });

        //start the child run
        const childAttempt = await engine.startRunAttempt({
          runId: childRun.id,
          snapshotId: dequeuedChild[0].snapshot.id,
        });

        let workerNotifications: EventBusEventArgs<"workerNotification">[0][] = [];
        engine.eventBus.on("workerNotification", (result) => {
          workerNotifications.push(result);
        });

        //cancel the parent run
        const result = await engine.cancelRun({
          runId: parentRun.id,
          completedAt: new Date(),
          reason: "Cancelled by the user",
        });
        expect(result.snapshot.executionStatus).toBe("PENDING_CANCEL");

        //check a worker notification was sent for the running parent
        expect(workerNotifications).toHaveLength(1);
        expect(workerNotifications[0].run.id).toBe(parentRun.id);

        const executionData = await engine.getRunExecutionData({ runId: parentRun.id });
        expect(executionData?.snapshot.executionStatus).toBe("PENDING_CANCEL");
        expect(executionData?.run.status).toBe("CANCELED");

        let cancelledEventData: EventBusEventArgs<"runCancelled">[0][] = [];
        engine.eventBus.on("runCancelled", (result) => {
          cancelledEventData.push(result);
        });

        //todo call completeAttempt (this will happen from the worker)
        const completeResult = await engine.completeRunAttempt({
          runId: parentRun.id,
          snapshotId: executionData!.snapshot.id,
          completion: {
            ok: false,
            id: executionData!.run.id,
            error: {
              type: "INTERNAL_ERROR" as const,
              code: "TASK_RUN_CANCELLED" as const,
            },
          },
        });

        //parent should now be fully cancelled
        const executionDataAfter = await engine.getRunExecutionData({ runId: parentRun.id });
        expect(executionDataAfter?.snapshot.executionStatus).toBe("FINISHED");
        expect(executionDataAfter?.run.status).toBe("CANCELED");

        //check emitted event
        expect(cancelledEventData.length).toBe(1);
        const parentEvent = cancelledEventData.find((r) => r.run.id === parentRun.id);
        assertNonNullable(parentEvent);
        expect(parentEvent.run.spanId).toBe(parentRun.spanId);

        //cancelling children is async, so we need to wait a brief moment
        await setTimeout(200);

        //check a worker notification was sent for the running parent
        expect(workerNotifications).toHaveLength(2);
        expect(workerNotifications[1].run.id).toBe(childRun.id);

        //child should now be pending cancel
        const childExecutionDataAfter = await engine.getRunExecutionData({ runId: childRun.id });
        expect(childExecutionDataAfter?.snapshot.executionStatus).toBe("PENDING_CANCEL");
        expect(childExecutionDataAfter?.run.status).toBe("CANCELED");

        //cancel the child (this will come from the worker)
        const completeChildResult = await engine.completeRunAttempt({
          runId: childRun.id,
          snapshotId: childExecutionDataAfter!.snapshot.id,
          completion: {
            ok: false,
            id: childRun.id,
            error: {
              type: "INTERNAL_ERROR" as const,
              code: "TASK_RUN_CANCELLED" as const,
            },
          },
        });
        expect(completeChildResult.snapshot.executionStatus).toBe("FINISHED");
        expect(completeChildResult.run.status).toBe("CANCELED");

        //child should now be pending cancel
        const childExecutionDataCancelled = await engine.getRunExecutionData({
          runId: childRun.id,
        });
        expect(childExecutionDataCancelled?.snapshot.executionStatus).toBe("FINISHED");
        expect(childExecutionDataCancelled?.run.status).toBe("CANCELED");

        //check emitted event
        expect(cancelledEventData.length).toBe(2);
        const childEvent = cancelledEventData.find((r) => r.run.id === childRun.id);
        assertNonNullable(childEvent);
        expect(childEvent.run.spanId).toBe(childRun.spanId);

        //concurrency should have been released
        const envConcurrencyCompleted = await engine.runQueue.currentConcurrencyOfEnvironment(
          authenticatedEnvironment
        );
        expect(envConcurrencyCompleted).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("Cancelling a run (not executing)", async ({ prisma, redisOptions }) => {
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

      //create background worker
      await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask]);

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
          queue: `task/${parentTask}`,
          isTest: false,
          tags: [],
        },
        prisma
      );

      //dequeue the run
      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: parentRun.masterQueue,
        maxRunCount: 10,
      });

      let cancelledEventData: EventBusEventArgs<"runCancelled">[0][] = [];
      engine.eventBus.on("runCancelled", (result) => {
        cancelledEventData.push(result);
      });

      //cancel the parent run
      const result = await engine.cancelRun({
        runId: parentRun.id,
        completedAt: new Date(),
        reason: "Cancelled by the user",
      });
      expect(result.snapshot.executionStatus).toBe("FINISHED");

      const executionData = await engine.getRunExecutionData({ runId: parentRun.id });
      expect(executionData?.snapshot.executionStatus).toBe("FINISHED");
      expect(executionData?.run.status).toBe("CANCELED");

      //check emitted event
      expect(cancelledEventData.length).toBe(1);
      const parentEvent = cancelledEventData.find((r) => r.run.id === parentRun.id);
      assertNonNullable(parentEvent);
      expect(parentEvent.run.spanId).toBe(parentRun.spanId);

      //concurrency should have been released
      const envConcurrencyCompleted = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );
      expect(envConcurrencyCompleted).toBe(0);
    } finally {
      await engine.quit();
    }
  });

  //todo bulk cancelling runs
});
