import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

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
          delayUntil: new Date(Date.now() + 500),
        },
        prisma
      );

      //should be delayed but not queued yet
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("DELAYED");

      //wait for 1 seconds
      await setTimeout(1_000);

      //should now be queued
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("QUEUED");
    } finally {
      await engine.quit();
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
          delayUntil: new Date(Date.now() + 400),
        },
        prisma
      );

      //should be delayed but not queued yet
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("DELAYED");

      const rescheduleTo = new Date(Date.now() + 1_500);
      const updatedRun = await engine.rescheduleDelayedRun({
        runId: run.id,
        delayUntil: rescheduleTo,
      });
      expect(updatedRun.delayUntil?.toISOString()).toBe(rescheduleTo.toISOString());

      //wait so the initial delay passes
      await setTimeout(1_000);

      //should still be delayed (rescheduled)
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("DELAYED");

      //wait so the updated delay passes
      await setTimeout(1_750);

      //should now be queued
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("QUEUED");
    } finally {
      await engine.quit();
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
          delayUntil: new Date(Date.now() + 1000),
          ttl: "2s",
        },
        prisma
      );

      //should be delayed but not queued yet
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("DELAYED");
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
      await engine.quit();
    }
  });

  containerTest("Cancelling a delayed run", async ({ prisma, redisOptions }) => {
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

      //trigger the run with a 1 second delay
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
          delayUntil: new Date(Date.now() + 1000),
        },
        prisma
      );

      //verify it's delayed but not queued
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("DELAYED");
      expect(run.status).toBe("DELAYED");

      //cancel the run
      await engine.cancelRun({
        runId: run.id,
        reason: "Cancelled by test",
      });

      //verify it's cancelled
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("FINISHED");
      expect(executionData2.run.status).toBe("CANCELED");

      //wait past the original delay time
      await setTimeout(1500);

      //verify the run is still cancelled
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("FINISHED");
      expect(executionData3.run.status).toBe("CANCELED");

      //attempt to dequeue - should get nothing
      await setTimeout(500);
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });

      expect(dequeued.length).toBe(0);

      //verify final state is still cancelled
      const executionData4 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData4);
      expect(executionData4.snapshot.executionStatus).toBe("FINISHED");
      expect(executionData4.run.status).toBe("CANCELED");
    } finally {
      await engine.quit();
    }
  });

  containerTest(
    "enqueueDelayedRun respects rescheduled delayUntil",
    async ({ prisma, redisOptions }) => {
      // This test verifies the race condition fix where if delayUntil is updated
      // (e.g., by debounce reschedule) while the worker job is executing,
      // the run should NOT be enqueued at the original time.
      //
      // The race condition occurs when:
      // 1. Worker job is scheduled for T1
      // 2. rescheduleDelayedRun updates delayUntil to T2 in DB
      // 3. worker.reschedule() tries to update the job, but it's already dequeued
      // 4. Original worker job fires and calls enqueueDelayedRun
      //
      // Without the fix: Run would be enqueued at T1 (wrong!)
      // With the fix: enqueueDelayedRun checks delayUntil > now and skips

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

        // Create a delayed run with a short delay (300ms)
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1235",
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
            delayUntil: new Date(Date.now() + 300),
          },
          prisma
        );

        // Verify it's delayed
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("DELAYED");

        // Simulate race condition: directly update delayUntil in the database to a future time
        // This simulates what happens when rescheduleDelayedRun updates the DB but the
        // worker.reschedule() call doesn't affect the already-dequeued job
        const newDelayUntil = new Date(Date.now() + 10_000); // 10 seconds in the future
        await prisma.taskRun.update({
          where: { id: run.id },
          data: { delayUntil: newDelayUntil },
        });

        // Wait past the original delay (500ms) so the worker job fires
        await setTimeout(500);

        // KEY ASSERTION: The run should still be DELAYED because the fix checks delayUntil > now
        // Without the fix, the run would be QUEUED here (wrong!)
        const executionData2 = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData2);
        expect(executionData2.snapshot.executionStatus).toBe("DELAYED");

        // Note: We don't test the run eventually becoming QUEUED here because we only
        // updated the DB (simulating the race). In the real scenario, rescheduleDelayedRun
        // would also reschedule the worker job to fire at the new delayUntil time.
      } finally {
        await engine.quit();
      }
    }
  );
});
