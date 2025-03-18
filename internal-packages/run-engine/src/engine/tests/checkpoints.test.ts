//todo checkpoint tests
import {
  containerTest,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
  assertNonNullable,
} from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "node:timers/promises";
import { EventBusEventArgs } from "../eventBus.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine checkpoints", () => {
  containerTest("Create checkpoint and continue execution", async ({ prisma, redisOptions }) => {
    // Create environment
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
        baseCostInCents: 0.0005,
      },
      tracer: trace.getTracer("test", "0.0.0"),
    });

    try {
      const taskIdentifier = "test-task";

      // Create background worker
      const backgroundWorker = await setupBackgroundWorker(
        prisma,
        authenticatedEnvironment,
        taskIdentifier
      );

      // Trigger the run
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

      // Dequeue the run
      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      // Create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });

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

      const checkpointRun = checkpointResult.ok ? checkpointResult.run : null;
      assertNonNullable(checkpointRun);

      // Verify checkpoint creation
      expect(snapshot.executionStatus).toBe("SUSPENDED");
      expect(checkpointRun.status).toBe("WAITING_TO_RESUME");

      // Get execution data to verify state
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("SUSPENDED");
      expect(executionData.checkpoint).toBeDefined();
      expect(executionData.checkpoint?.type).toBe("DOCKER");
      expect(executionData.checkpoint?.reason).toBe("TEST_CHECKPOINT");

      //complete the waitpoint
      await engine.completeWaitpoint({
        id: waitpointResult.waitpoint.id,
      });

      await setTimeout(500);

      // Dequeue the run again
      const dequeuedAgain = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      expect(dequeuedAgain.length).toBe(1);

      // Continue execution from checkpoint
      const continueResult = await engine.continueRunExecution({
        runId: run.id,
        snapshotId: dequeuedAgain[0].snapshot.id,
      });

      // Verify continuation
      expect(continueResult.snapshot.executionStatus).toBe("EXECUTING");
      expect(continueResult.run.status).toBe("EXECUTING");

      // Complete the run
      const result = await engine.completeRunAttempt({
        runId: run.id,
        snapshotId: continueResult.snapshot.id,
        completion: {
          ok: true,
          id: run.id,
          output: `{"foo":"bar"}`,
          outputType: "application/json",
        },
      });

      // Verify final state
      expect(result.snapshot.executionStatus).toBe("FINISHED");
      expect(result.run.status).toBe("COMPLETED_SUCCESSFULLY");
    } finally {
      await engine.quit();
    }
  });

  containerTest("Failed checkpoint creation", async ({ prisma, redisOptions }) => {
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
        baseCostInCents: 0.0005,
      },
      tracer: trace.getTracer("test", "0.0.0"),
    });

    try {
      const taskIdentifier = "test-task";

      // Create background worker
      const backgroundWorker = await setupBackgroundWorker(
        prisma,
        authenticatedEnvironment,
        taskIdentifier
      );

      // Trigger the run
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

      // Try to create checkpoint with invalid snapshot ID
      const result = await engine.createCheckpoint({
        runId: run.id,
        snapshotId: "invalid-snapshot-id",
        checkpoint: {
          type: "DOCKER",
          reason: "TEST_CHECKPOINT",
          location: "test-location",
          imageRef: "test-image-ref",
        },
      });

      const error = !result.ok ? result.error : null;

      expect(error).toBe("Not the latest snapshot");

      // Verify run is still in initial state
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.checkpoint).toBeUndefined();
    } finally {
      await engine.quit();
    }
  });

  containerTest("Multiple checkpoints in single run", async ({ prisma, redisOptions }) => {
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
        baseCostInCents: 0.0005,
      },
      tracer: trace.getTracer("test", "0.0.0"),
    });

    try {
      const taskIdentifier = "test-task";
      const backgroundWorker = await setupBackgroundWorker(
        prisma,
        authenticatedEnvironment,
        taskIdentifier
      );

      // Trigger run
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

      // First checkpoint sequence
      const dequeued1 = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      const attemptResult1 = await engine.startRunAttempt({
        runId: dequeued1[0].run.id,
        snapshotId: dequeued1[0].snapshot.id,
      });

      // Create waitpoint and block run
      const waitpoint1 = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
      });

      const blocked1 = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: waitpoint1.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
      });

      // Create first checkpoint
      const checkpoint1 = await engine.createCheckpoint({
        runId: run.id,
        snapshotId: blocked1.id,
        checkpoint: {
          type: "DOCKER",
          reason: "CHECKPOINT_1",
          location: "location-1",
          imageRef: "image-1",
        },
      });

      expect(checkpoint1.ok).toBe(true);
      const snapshot1 = checkpoint1.ok ? checkpoint1.snapshot : null;
      assertNonNullable(snapshot1);

      // Complete first waitpoint
      await engine.completeWaitpoint({
        id: waitpoint1.waitpoint.id,
      });

      await setTimeout(500);

      // Dequeue again after waitpoint completion
      const dequeued2 = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      // Continue execution from first checkpoint
      const continueResult1 = await engine.continueRunExecution({
        runId: run.id,
        snapshotId: dequeued2[0].snapshot.id,
      });

      // Second checkpoint sequence
      // Create another waitpoint and block run
      const waitpoint2 = await engine.createManualWaitpoint({
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
      });

      const blocked2 = await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: waitpoint2.waitpoint.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
      });

      // Create second checkpoint
      const checkpoint2 = await engine.createCheckpoint({
        runId: run.id,
        snapshotId: blocked2.id,
        checkpoint: {
          type: "DOCKER",
          reason: "CHECKPOINT_2",
          location: "location-2",
          imageRef: "image-2",
        },
      });

      expect(checkpoint2.ok).toBe(true);
      const snapshot2 = checkpoint2.ok ? checkpoint2.snapshot : null;
      assertNonNullable(snapshot2);

      // Complete second waitpoint
      await engine.completeWaitpoint({
        id: waitpoint2.waitpoint.id,
      });

      await setTimeout(500);

      // Dequeue again after second waitpoint completion
      const dequeued3 = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      expect(dequeued3.length).toBe(1);

      // Verify latest checkpoint
      expect(dequeued3[0].checkpoint?.reason).toBe("CHECKPOINT_2");
      expect(dequeued3[0].checkpoint?.location).toBe("location-2");

      // Continue execution from second checkpoint
      const continueResult2 = await engine.continueRunExecution({
        runId: run.id,
        snapshotId: dequeued3[0].snapshot.id,
      });

      // Complete the run
      const result = await engine.completeRunAttempt({
        runId: run.id,
        snapshotId: continueResult2.snapshot.id,
        completion: {
          ok: true,
          id: run.id,
          output: `{"foo":"bar"}`,
          outputType: "application/json",
        },
      });

      expect(result.snapshot.executionStatus).toBe("FINISHED");
      expect(result.run.status).toBe("COMPLETED_SUCCESSFULLY");
    } finally {
      await engine.quit();
    }
  });

  containerTest(
    "Checkpoint after waitpoint completion with concurrency reacquisition",
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
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        // Create background worker
        const backgroundWorker = await setupBackgroundWorker(
          prisma,
          authenticatedEnvironment,
          taskIdentifier
        );

        // Trigger the run
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

        // Dequeue the run
        const dequeued = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: run.masterQueue,
          maxRunCount: 10,
        });

        // Create an attempt
        const attemptResult = await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        // Create and block with waitpoint
        const waitpointResult = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });
        expect(waitpointResult.waitpoint.status).toBe("PENDING");

        const blockedResult = await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpointResult.waitpoint.id,
          projectId: authenticatedEnvironment.projectId,
          organizationId: authenticatedEnvironment.organizationId,
          releaseConcurrency: true, // Important: Release concurrency when blocking
        });

        // Verify run is blocked
        const blockedExecutionData = await engine.getRunExecutionData({ runId: run.id });
        expect(blockedExecutionData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        // Complete the waitpoint before checkpoint
        await engine.completeWaitpoint({
          id: waitpointResult.waitpoint.id,
        });

        await setTimeout(500); // Wait for continueRunIfUnblocked to process

        // Create checkpoint after waitpoint completion
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

        expect(checkpointResult.ok).toBe(false);
        const error = !checkpointResult.ok ? checkpointResult.error : null;
        expect(error).toBe("Not the latest snapshot");

        // Verify checkpoint state
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("EXECUTING");

        // Complete the run
        const result = await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: executionData.snapshot.id,
          completion: {
            ok: true,
            id: run.id,
            output: `{"foo":"bar"}`,
            outputType: "application/json",
          },
        });

        // Verify final state
        expect(result.snapshot.executionStatus).toBe("FINISHED");
        expect(result.run.status).toBe("COMPLETED_SUCCESSFULLY");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "Cannot create checkpoint in non-checkpointable state",
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
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        // Create background worker
        const backgroundWorker = await setupBackgroundWorker(
          prisma,
          authenticatedEnvironment,
          taskIdentifier
        );

        // Trigger the run
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

        // Dequeue the run
        const dequeued = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: run.masterQueue,
          maxRunCount: 10,
        });

        // Create an attempt
        const attemptResult = await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        // First create a valid checkpoint to get into SUSPENDED state
        const checkpoint1 = await engine.createCheckpoint({
          runId: run.id,
          snapshotId: attemptResult.snapshot.id,
          checkpoint: {
            type: "DOCKER",
            reason: "FIRST_CHECKPOINT",
            location: "test-location-1",
            imageRef: "test-image-ref-1",
          },
        });

        expect(checkpoint1.ok).toBe(true);
        const snapshot1 = checkpoint1.ok ? checkpoint1.snapshot : null;
        assertNonNullable(snapshot1);

        // Verify we're in SUSPENDED state
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("SUSPENDED");

        let event: EventBusEventArgs<"incomingCheckpointDiscarded">[0] | undefined = undefined;
        engine.eventBus.on("incomingCheckpointDiscarded", (result) => {
          event = result;
        });

        // Try to create another checkpoint while in SUSPENDED state
        const checkpoint2 = await engine.createCheckpoint({
          runId: run.id,
          snapshotId: snapshot1.id,
          checkpoint: {
            type: "DOCKER",
            reason: "SECOND_CHECKPOINT",
            location: "test-location-2",
            imageRef: "test-image-ref-2",
          },
        });

        assertNonNullable(event);

        const notificationEvent = event as EventBusEventArgs<"incomingCheckpointDiscarded">[0];
        expect(notificationEvent.run.id).toBe(run.id);

        expect(notificationEvent.run.id).toBe(run.id);
        expect(notificationEvent.checkpoint.discardReason).toBe(
          "Status SUSPENDED is not checkpointable"
        );

        // Verify the checkpoint creation was rejected
        expect(checkpoint2.ok).toBe(false);
        const error = !checkpoint2.ok ? checkpoint2.error : null;
        expect(error).toBe("Status SUSPENDED is not checkpointable");

        // Verify the run state hasn't changed
        const finalExecutionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(finalExecutionData);
        expect(finalExecutionData.snapshot.executionStatus).toBe("SUSPENDED");
        expect(finalExecutionData.checkpoint?.reason).toBe("FIRST_CHECKPOINT");
      } finally {
        await engine.quit();
      }
    }
  );
});
