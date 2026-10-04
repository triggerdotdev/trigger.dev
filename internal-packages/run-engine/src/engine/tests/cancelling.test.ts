import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";
import type { EventBusEventArgs } from "../eventBus.js";
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
        const _childAttempt = await engine.startRunAttempt({
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
        const _completeResult = await engine.completeRunAttempt({
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
        const envConcurrencyCompleted =
          await engine.runQueue.currentConcurrencyOfEnvironment(authenticatedEnvironment);
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
      const envConcurrencyCompleted =
        await engine.runQueue.currentConcurrencyOfEnvironment(authenticatedEnvironment);
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
      const envConcurrencyCompleted =
        await engine.runQueue.currentConcurrencyOfEnvironment(authenticatedEnvironment);
      expect(envConcurrencyCompleted).toBe(0);
    } finally {
      await engine.quit();
    }
  });

  containerTest(
    "Finalizing a cancelled executing run keeps the cancel reason",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createCancellingTestEngine(prisma, redisOptions);

      try {
        const parentTask = "parent-task";
        const childTask = "child-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

        const parentRun = await triggerAndStart(engine, authenticatedEnvironment, {
          friendlyId: "run_p1234",
          taskIdentifier: parentTask,
        });
        const childRun = await triggerAndStart(engine, authenticatedEnvironment, {
          friendlyId: "run_c1234",
          taskIdentifier: childTask,
          resumeParentOnCompletion: true,
          parentTaskRunId: parentRun.id,
        });

        const cancelledEvents: EventBusEventArgs<"runCancelled">[0][] = [];
        engine.eventBus.on("runCancelled", (event) => {
          cancelledEvents.push(event);
        });

        const reason = "support: test reason";
        const pending = await engine.cancelRun({ runId: childRun.id, reason });
        expect(pending.snapshot.executionStatus).toBe("PENDING_CANCEL");

        const pendingRun = await prisma.taskRun.findUniqueOrThrow({ where: { id: childRun.id } });
        expect(pendingRun.error).toEqual({ type: "STRING_ERROR", raw: reason });

        const finalized = await engine.cancelRun({ runId: childRun.id, finalizeRun: true });
        expect(finalized.snapshot.executionStatus).toBe("FINISHED");

        const finalRun = await prisma.taskRun.findUniqueOrThrow({ where: { id: childRun.id } });
        expect(finalRun.status).toBe("CANCELED");
        expect(finalRun.error).toEqual({ type: "STRING_ERROR", raw: reason });

        expect(cancelledEvents).toHaveLength(1);
        expect(cancelledEvents[0].run.error).toEqual({ type: "STRING_ERROR", raw: reason });

        const parentWaitpoint = await prisma.waitpoint.findFirstOrThrow({
          where: { completedByTaskRunId: childRun.id },
        });
        expect(parentWaitpoint.outputIsError).toBe(true);
        expect(JSON.parse(parentWaitpoint.output!)).toEqual({ type: "STRING_ERROR", raw: reason });
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Cancelling an executing run without a reason uses the default text",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createCancellingTestEngine(prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const run = await triggerAndStart(engine, authenticatedEnvironment, {
          friendlyId: "run_1234",
          taskIdentifier,
        });

        const pending = await engine.cancelRun({ runId: run.id });
        expect(pending.snapshot.executionStatus).toBe("PENDING_CANCEL");

        const finalized = await engine.cancelRun({ runId: run.id, finalizeRun: true });
        expect(finalized.snapshot.executionStatus).toBe("FINISHED");

        const finalRun = await prisma.taskRun.findUniqueOrThrow({ where: { id: run.id } });
        expect(finalRun.status).toBe("CANCELED");
        expect(finalRun.error).toEqual({ type: "STRING_ERROR", raw: "Canceled by user" });
      } finally {
        await engine.quit();
      }
    }
  );

  //todo bulk cancelling runs
});

function createCancellingTestEngine(
  prisma: ConstructorParameters<typeof RunEngine>[0]["prisma"],
  redisOptions: ConstructorParameters<typeof RunEngine>[0]["runLock"]["redis"]
) {
  return new RunEngine({
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

async function triggerAndStart(
  engine: RunEngine,
  environment: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>,
  options: {
    friendlyId: string;
    taskIdentifier: string;
    resumeParentOnCompletion?: boolean;
    parentTaskRunId?: string;
  }
) {
  const run = await engine.trigger(
    {
      number: 1,
      friendlyId: options.friendlyId,
      environment,
      taskIdentifier: options.taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      workerQueue: "main",
      queue: `task/${options.taskIdentifier}`,
      isTest: false,
      tags: [],
      resumeParentOnCompletion: options.resumeParentOnCompletion,
      parentTaskRunId: options.parentTaskRunId,
    },
    engine.prisma
  );

  await setTimeout(500);
  const dequeued = await engine.dequeueFromWorkerQueue({
    consumerId: "test_12345",
    workerQueue: "main",
  });

  const attempt = await engine.startRunAttempt({
    runId: dequeued[0].run.id,
    snapshotId: dequeued[0].snapshot.id,
  });
  expect(attempt.snapshot.executionStatus).toBe("EXECUTING");

  return run;
}
