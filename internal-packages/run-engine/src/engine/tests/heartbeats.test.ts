import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine heartbeats", () => {
  containerTest("Attempt timeout then successfully attempted", async ({ prisma, redisOptions }) => {
    //create environment
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const pendingExecutingTimeout = 100;

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
        retryOptions: {
          maxTimeoutInMs: 50,
        },
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
      heartbeatTimeoutsMs: {
        PENDING_EXECUTING: pendingExecutingTimeout,
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

      //expect it to be pending with 0 consecutiveFailures
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("PENDING_EXECUTING");

      await setTimeout(pendingExecutingTimeout * 4);

      //expect it to be pending with 3 consecutiveFailures
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("QUEUED");

      await setTimeout(1_000);

      //have to dequeue again
      const dequeued2 = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });
      expect(dequeued2.length).toBe(1);

      // create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued2[0].run.id,
        snapshotId: dequeued2[0].snapshot.id,
      });
      expect(attemptResult.run.id).toBe(run.id);
      expect(attemptResult.run.status).toBe("EXECUTING");
      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");
    } finally {
      await engine.quit();
    }
  });

  containerTest("All start attempts timeout", async ({ prisma, redisOptions }) => {
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const pendingExecutingTimeout = 100;

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
        retryOptions: {
          //intentionally set the attempts to 2 and quick
          maxAttempts: 2,
          minTimeoutInMs: 50,
          maxTimeoutInMs: 50,
        },
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
      heartbeatTimeoutsMs: {
        PENDING_EXECUTING: pendingExecutingTimeout,
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

      //expect it to be pending
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("PENDING_EXECUTING");

      await setTimeout(500);

      //expect it to be pending with 3 consecutiveFailures
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("QUEUED");

      //have to dequeue again
      const dequeued2 = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });
      expect(dequeued2.length).toBe(1);

      //expect it to be pending
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("PENDING_EXECUTING");

      await setTimeout(pendingExecutingTimeout * 3);

      //expect it to be pending with 3 consecutiveFailures
      const executionData4 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData4);
      expect(executionData4.snapshot.executionStatus).toBe("FINISHED");
      expect(executionData4.run.status).toBe("SYSTEM_FAILURE");
    } finally {
      await engine.quit();
    }
  });

  containerTest(
    "Execution timeout (worker doesn't heartbeat)",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const executingTimeout = 100;

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
          retryOptions: {
            //intentionally set the attempts to 2 and quick
            maxAttempts: 2,
            minTimeoutInMs: 50,
            maxTimeoutInMs: 50,
          },
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
        heartbeatTimeoutsMs: {
          EXECUTING: executingTimeout,
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
        await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        //should be executing
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("EXECUTING");
        expect(executionData.run.status).toBe("EXECUTING");

        //wait long enough for the heartbeat to timeout
        await setTimeout(1_000);

        //expect it to be queued again
        const executionData2 = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData2);
        expect(executionData2.snapshot.executionStatus).toBe("QUEUED");

        //have to dequeue again
        const dequeued2 = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: run.masterQueue,
          maxRunCount: 10,
        });
        expect(dequeued2.length).toBe(1);

        //create an attempt
        await engine.startRunAttempt({
          runId: dequeued2[0].run.id,
          snapshotId: dequeued2[0].snapshot.id,
        });

        //should be executing
        const executionData3 = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData3);
        expect(executionData3.snapshot.executionStatus).toBe("EXECUTING");
        expect(executionData3.run.status).toBe("EXECUTING");

        //again wait long enough that the heartbeat fails
        await setTimeout(1_000);

        //expect it to be queued again
        const executionData4 = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData4);
        expect(executionData4.snapshot.executionStatus).toBe("FINISHED");
        expect(executionData4.run.status).toBe("SYSTEM_FAILURE");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("Pending cancel", async ({ prisma, redisOptions }) => {
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const heartbeatTimeout = 100;

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
      heartbeatTimeoutsMs: {
        PENDING_CANCEL: heartbeatTimeout,
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
      await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      //cancel run
      await engine.cancelRun({ runId: dequeued[0].run.id });

      //expect it to be pending_cancel
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("PENDING_CANCEL");

      //wait long enough for the heartbeat to timeout
      await setTimeout(1_000);

      //expect it to be queued again
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("FINISHED");
      expect(executionData3.run.status).toBe("CANCELED");
    } finally {
      await engine.quit();
    }
  });

  containerTest("Suspended", async ({ prisma, redisOptions }) => {
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const heartbeatTimeout = 1000;

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
      heartbeatTimeoutsMs: {
        SUSPENDED: heartbeatTimeout,
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
      await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      //cancel run
      //create a manual waitpoint
      const waitpointResult = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
      });
      expect(waitpointResult.waitpoint.status).toBe("PENDING");

      //block the run
      const blockedResult = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: waitpointResult.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
      });

      const blockedExecutionData = await engine.getRunExecutionData({ runId: run.id });
      expect(blockedExecutionData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      // Create a checkpoint
      const checkpointResult = await engine.createCheckpoint({
        runId: run.id,
        snapshotId: blockedResult.id,
        checkpoint: {
          type: "DOCKER",
          reason: "TEST_CHECKPOINT",
          location: "test-location",
          imageRef: "test-image-ref",
        },
      });

      expect(checkpointResult.ok).toBe(true);

      const snapshot = checkpointResult.ok ? checkpointResult.snapshot : null;

      assertNonNullable(snapshot);

      // Verify checkpoint creation
      expect(snapshot.executionStatus).toBe("SUSPENDED");

      // Now wait for the heartbeat to timeout, but it should retry later
      await setTimeout(heartbeatTimeout * 1.5);

      // Simulate a suspended run without any blocking waitpoints by deleting any blocking task run waitpoints
      await prisma.taskRunWaitpoint.deleteMany({
        where: {
          taskRunId: run.id,
        },
      });

      // Now wait for the heartbeat to timeout again
      await setTimeout(heartbeatTimeout * 2);

      // Expect the run to be queued
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("QUEUED");
    } finally {
      await engine.quit();
    }
  });

  containerTest("Heartbeat keeps run alive", async ({ prisma, redisOptions }) => {
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const executingTimeout = 100;

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
      heartbeatTimeoutsMs: {
        EXECUTING: executingTimeout,
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
      const attempt = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

      //should be executing
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("EXECUTING");
      expect(executionData.run.status).toBe("EXECUTING");

      // Send heartbeats every 50ms (half the timeout)
      for (let i = 0; i < 6; i++) {
        await setTimeout(50);
        await engine.heartbeatRun({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
        });
      }

      // After 300ms (3x the timeout) the run should still be executing
      // because we've been sending heartbeats
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("EXECUTING");
      expect(executionData2.run.status).toBe("EXECUTING");

      // Stop sending heartbeats and wait for timeout
      await setTimeout(executingTimeout * 3);

      // Now it should have timed out and be queued
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("QUEUED");
    } finally {
      await engine.quit();
    }
  });
});
