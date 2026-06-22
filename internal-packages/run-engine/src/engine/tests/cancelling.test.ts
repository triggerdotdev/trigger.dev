import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { isKsuidId, RunId } from "@trigger.dev/core/v3/isomorphic";
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
            workerQueue: "main",
            queue: `task/${parentTask}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        //dequeue the run
        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
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
            workerQueue: "main",
            queue: `task/${childTask}`,
            isTest: false,
            tags: [],
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun.id,
          },
          prisma
        );

        //dequeue the child run
        await setTimeout(500);
        const dequeuedChild = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
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

        // call completeAttempt manually (this will happen from the worker)
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

  containerTest(
    "Cancelling a parent cascades to a child in the OTHER run table (cross-table mixed window)",
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

        // Parent gets a cuid id (-> TaskRun); child gets a ksuid id
        // (-> task_run_v2). This is exactly the hierarchy a runTableV2 flip
        // creates while a pre-flip parent is still live.
        const parentId = RunId.generate();
        const childId = RunId.generateKsuid();

        const parentRun = await engine.trigger(
          {
            number: 1,
            friendlyId: parentId.friendlyId,
            environment: authenticatedEnvironment,
            taskIdentifier: parentTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "tp",
            spanId: "sp",
            workerQueue: "main",
            queue: `task/${parentTask}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        const childRun = await engine.trigger(
          {
            number: 1,
            friendlyId: childId.friendlyId,
            environment: authenticatedEnvironment,
            taskIdentifier: childTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "tc",
            spanId: "sc",
            workerQueue: "main",
            queue: `task/${childTask}`,
            isTest: false,
            tags: [],
            parentTaskRunId: parentRun.id,
          },
          prisma
        );

        // The hierarchy genuinely straddles the two physical run tables.
        expect(isKsuidId(parentRun.id)).toBe(false);
        expect(isKsuidId(childRun.id)).toBe(true);

        // Cancel the (queued) parent. Pre-fix, cancelRun read children through
        // the table-bound childRuns relation, which cannot see the v2 child, so
        // the cascade skipped it and it kept its place in the queue. Post-fix,
        // the cross-table findRuns finds the child and cancels it too.
        await engine.cancelRun({
          runId: parentRun.id,
          completedAt: new Date(),
          reason: "Cancelled by the user",
        });

        // The child cancellation is enqueued as a job; give the worker a moment.
        await setTimeout(1000);

        const childData = await engine.getRunExecutionData({ runId: childRun.id });
        expect(childData?.run.status).toBe("CANCELED");
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
          workerQueue: "main",
          queue: `task/${parentTask}`,
          isTest: false,
          tags: [],
        },
        prisma
      );

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

  containerTest("Cancelling a run (dequeued)", async ({ prisma, redisOptions }) => {
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
          workerQueue: "main",
          queue: `task/${parentTask}`,
          isTest: false,
          tags: [],
        },
        prisma
      );

      //dequeue the run, but don't start an attempt — this leaves TaskRun.status = DEQUEUED
      //and execution snapshot = PENDING_EXECUTING (a worker has claimed the run)
      await setTimeout(500);
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      expect(dequeued.length).toBe(1);

      const dequeuedRun = await prisma.taskRun.findFirstOrThrow({
        where: { id: parentRun.id },
      });
      expect(dequeuedRun.status).toBe("DEQUEUED");

      //cancel the dequeued run — a worker has already claimed it, so the snapshot goes to
      //PENDING_CANCEL pending the worker ack. TaskRun.status flips to CANCELED immediately
      //so the UI reflects cancellation without waiting.
      const result = await engine.cancelRun({
        runId: parentRun.id,
        completedAt: new Date(),
        reason: "Cancelled by the user",
      });
      expect(result.snapshot.executionStatus).toBe("PENDING_CANCEL");

      const pendingCancel = await engine.getRunExecutionData({ runId: parentRun.id });
      expect(pendingCancel?.snapshot.executionStatus).toBe("PENDING_CANCEL");
      expect(pendingCancel?.run.status).toBe("CANCELED");

      let cancelledEventData: EventBusEventArgs<"runCancelled">[0][] = [];
      engine.eventBus.on("runCancelled", (result) => {
        cancelledEventData.push(result);
      });

      //simulate worker acknowledging the cancellation
      const completeResult = await engine.completeRunAttempt({
        runId: parentRun.id,
        snapshotId: pendingCancel!.snapshot.id,
        completion: {
          ok: false,
          id: parentRun.id,
          error: {
            type: "INTERNAL_ERROR" as const,
            code: "TASK_RUN_CANCELLED" as const,
          },
        },
      });
      expect(completeResult.snapshot.executionStatus).toBe("FINISHED");
      expect(completeResult.run.status).toBe("CANCELED");

      //check emitted event after worker ack
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
