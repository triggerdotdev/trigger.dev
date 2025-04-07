import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "node:timers/promises";
import { EventBusEventArgs } from "../eventBus.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";

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
        engine,
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
          queue: "task/test-task",
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
        engine,
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
          queue: "task/test-task",
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
        engine,
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
          queue: "task/test-task",
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
          engine,
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
            queue: "task/test-task",
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
          engine,
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
            queue: "task/test-task",
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

  containerTest(
    "when a checkpoint is created while the run is in QUEUED_EXECUTING state, the run is QUEUED",
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

        // Create checkpoint after waitpoint completion
        const checkpointResult = await engine.createCheckpoint({
          runId: firstRun.id,
          snapshotId: firstRunData?.snapshot.id!,
          checkpoint: {
            type: "DOCKER",
            reason: "TEST_CHECKPOINT",
            location: "test-location",
            imageRef: "test-image-ref",
          },
        });

        expect(checkpointResult.ok).toBe(true);
        const checkpoint = checkpointResult.ok ? checkpointResult.snapshot : null;
        assertNonNullable(checkpoint);
        expect(checkpoint.executionStatus).toBe("QUEUED");

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

        // Verify the first run is back in the queue
        const queuedRun = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: firstRun.masterQueue,
          maxRunCount: 10,
        });

        expect(queuedRun.length).toBe(1);
        expect(queuedRun[0].run.id).toBe(firstRun.id);
        expect(queuedRun[0].snapshot.executionStatus).toBe("PENDING_EXECUTING");

        // Now we can continue the run
        const continueResult = await engine.continueRunExecution({
          runId: firstRun.id,
          snapshotId: queuedRun[0].snapshot.id,
        });

        expect(continueResult.snapshot.executionStatus).toBe("EXECUTING");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("batchTriggerAndWait resume after checkpoint", async ({ prisma, redisOptions }) => {
    //create environment
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const engine = new RunEngine({
      prisma,
      worker: {
        redis: redisOptions,
        workers: 1,
        tasksPerWorker: 10,
        pollIntervalMs: 20,
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

      //create a batch
      const batch = await prisma.batchTaskRun.create({
        data: {
          friendlyId: generateFriendlyId("batch"),
          runtimeEnvironmentId: authenticatedEnvironment.id,
        },
      });

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

      //block using the batch
      await engine.blockRunWithCreatedBatch({
        runId: parentRun.id,
        batchId: batch.id,
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
        organizationId: authenticatedEnvironment.organizationId,
      });

      const afterBlockedByBatch = await engine.getRunExecutionData({ runId: parentRun.id });
      assertNonNullable(afterBlockedByBatch);
      expect(afterBlockedByBatch.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      const child1 = await engine.trigger(
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
          batch: { id: batch.id, index: 0 },
        },
        prisma
      );

      const parentAfterChild1 = await engine.getRunExecutionData({ runId: parentRun.id });
      assertNonNullable(parentAfterChild1);
      expect(parentAfterChild1.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      const child2 = await engine.trigger(
        {
          number: 2,
          friendlyId: "run_c12345",
          environment: authenticatedEnvironment,
          taskIdentifier: childTask,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t123456",
          spanId: "s123456",
          masterQueue: "main",
          queue: `task/${childTask}`,
          isTest: false,
          tags: [],
          resumeParentOnCompletion: true,
          parentTaskRunId: parentRun.id,
          batch: { id: batch.id, index: 1 },
        },
        prisma
      );

      const parentAfterChild2 = await engine.getRunExecutionData({ runId: parentRun.id });
      assertNonNullable(parentAfterChild2);
      expect(parentAfterChild2.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      //check the waitpoint blocking the parent run
      const runWaitpoints = await prisma.taskRunWaitpoint.findMany({
        where: {
          taskRunId: parentRun.id,
        },
        include: {
          waitpoint: true,
        },
        orderBy: {
          createdAt: "asc",
        },
      });
      expect(runWaitpoints.length).toBe(3);
      const child1Waitpoint = runWaitpoints.find(
        (w) => w.waitpoint.completedByTaskRunId === child1.id
      );
      expect(child1Waitpoint?.waitpoint.type).toBe("RUN");
      expect(child1Waitpoint?.waitpoint.completedByTaskRunId).toBe(child1.id);
      expect(child1Waitpoint?.batchId).toBe(batch.id);
      expect(child1Waitpoint?.batchIndex).toBe(0);
      const child2Waitpoint = runWaitpoints.find(
        (w) => w.waitpoint.completedByTaskRunId === child2.id
      );
      expect(child2Waitpoint?.waitpoint.type).toBe("RUN");
      expect(child2Waitpoint?.waitpoint.completedByTaskRunId).toBe(child2.id);
      expect(child2Waitpoint?.batchId).toBe(batch.id);
      expect(child2Waitpoint?.batchIndex).toBe(1);
      const batchWaitpoint = runWaitpoints.find((w) => w.waitpoint.type === "BATCH");
      expect(batchWaitpoint?.waitpoint.type).toBe("BATCH");
      expect(batchWaitpoint?.waitpoint.completedByBatchId).toBe(batch.id);

      await engine.unblockRunForCreatedBatch({
        runId: parentRun.id,
        batchId: batch.id,
        environmentId: authenticatedEnvironment.id,
        projectId: authenticatedEnvironment.projectId,
      });

      // Create a checkpoint
      const checkpointResult = await engine.createCheckpoint({
        runId: parentRun.id,
        snapshotId: parentAfterChild2.snapshot.id,
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
      const executionData = await engine.getRunExecutionData({ runId: parentRun.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("SUSPENDED");
      expect(executionData.checkpoint).toBeDefined();
      expect(executionData.checkpoint?.type).toBe("DOCKER");
      expect(executionData.checkpoint?.reason).toBe("TEST_CHECKPOINT");

      //dequeue and start the 1st child
      const dequeuedChild = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: child1.masterQueue,
        maxRunCount: 1,
      });

      expect(dequeuedChild.length).toBe(1);

      const childAttempt1 = await engine.startRunAttempt({
        runId: dequeuedChild[0].run.id,
        snapshotId: dequeuedChild[0].snapshot.id,
      });

      // complete the 1st child
      await engine.completeRunAttempt({
        runId: childAttempt1.run.id,
        snapshotId: childAttempt1.snapshot.id,
        completion: {
          id: child1.id,
          ok: true,
          output: '{"foo":"bar"}',
          outputType: "application/json",
        },
      });

      //child snapshot
      const childExecutionDataAfter = await engine.getRunExecutionData({
        runId: childAttempt1.run.id,
      });
      assertNonNullable(childExecutionDataAfter);
      expect(childExecutionDataAfter.snapshot.executionStatus).toBe("FINISHED");

      const child1WaitpointAfter = await prisma.waitpoint.findFirst({
        where: {
          id: child1Waitpoint?.waitpointId,
        },
      });
      expect(child1WaitpointAfter?.completedAt).not.toBeNull();
      expect(child1WaitpointAfter?.status).toBe("COMPLETED");
      expect(child1WaitpointAfter?.output).toBe('{"foo":"bar"}');

      await setTimeout(500);

      const runWaitpointsAfterFirstChild = await prisma.taskRunWaitpoint.findMany({
        where: {
          taskRunId: parentRun.id,
        },
        include: {
          waitpoint: true,
        },
      });
      expect(runWaitpointsAfterFirstChild.length).toBe(3);

      //parent snapshot
      const parentExecutionDataAfterFirstChildComplete = await engine.getRunExecutionData({
        runId: parentRun.id,
      });
      assertNonNullable(parentExecutionDataAfterFirstChildComplete);
      expect(parentExecutionDataAfterFirstChildComplete.snapshot.executionStatus).toBe("SUSPENDED");
      expect(parentExecutionDataAfterFirstChildComplete.batch?.id).toBe(batch.id);
      expect(parentExecutionDataAfterFirstChildComplete.completedWaitpoints.length).toBe(0);

      expect(await engine.runQueue.lengthOfEnvQueue(authenticatedEnvironment)).toBe(1);

      //dequeue and start the 2nd child
      const dequeuedChild2 = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: child2.masterQueue,
        maxRunCount: 1,
      });

      expect(dequeuedChild2.length).toBe(1);

      const childAttempt2 = await engine.startRunAttempt({
        runId: child2.id,
        snapshotId: dequeuedChild2[0].snapshot.id,
      });
      await engine.completeRunAttempt({
        runId: child2.id,
        snapshotId: childAttempt2.snapshot.id,
        completion: {
          id: child2.id,
          ok: true,
          output: '{"baz":"qux"}',
          outputType: "application/json",
        },
      });

      //child snapshot
      const child2ExecutionDataAfter = await engine.getRunExecutionData({ runId: child1.id });
      assertNonNullable(child2ExecutionDataAfter);
      expect(child2ExecutionDataAfter.snapshot.executionStatus).toBe("FINISHED");

      const child2WaitpointAfter = await prisma.waitpoint.findFirst({
        where: {
          id: child2Waitpoint?.waitpointId,
        },
      });
      expect(child2WaitpointAfter?.completedAt).not.toBeNull();
      expect(child2WaitpointAfter?.status).toBe("COMPLETED");
      expect(child2WaitpointAfter?.output).toBe('{"baz":"qux"}');

      await setTimeout(500);

      const runWaitpointsAfterSecondChild = await prisma.taskRunWaitpoint.findMany({
        where: {
          taskRunId: parentRun.id,
        },
        include: {
          waitpoint: true,
        },
      });
      expect(runWaitpointsAfterSecondChild.length).toBe(0);

      //parent snapshot
      const parentExecutionDataAfterSecondChildComplete = await engine.getRunExecutionData({
        runId: parentRun.id,
      });
      assertNonNullable(parentExecutionDataAfterSecondChildComplete);
      expect(parentExecutionDataAfterSecondChildComplete.snapshot.executionStatus).toBe("QUEUED");
      expect(parentExecutionDataAfterSecondChildComplete.batch?.id).toBe(batch.id);
      expect(parentExecutionDataAfterSecondChildComplete.completedWaitpoints.length).toBe(3);

      // Dequeue the run
      const dequeuedParentAfterCheckpoint = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: parentRun.masterQueue,
        maxRunCount: 10,
      });

      expect(dequeuedParentAfterCheckpoint.length).toBe(1);
      expect(dequeuedParentAfterCheckpoint[0].run.id).toBe(parentRun.id);
      expect(dequeuedParentAfterCheckpoint[0].snapshot.executionStatus).toBe("PENDING_EXECUTING");

      // Create an attempt
      const parentResumed = await engine.continueRunExecution({
        runId: dequeuedParentAfterCheckpoint[0].run.id,
        snapshotId: dequeuedParentAfterCheckpoint[0].snapshot.id,
      });

      expect(parentResumed.snapshot.executionStatus).toBe("EXECUTING");

      const execution = await engine.getRunExecutionData({ runId: parentRun.id });
      expect(execution?.snapshot.executionStatus).toBe("EXECUTING");
      expect(execution?.batch?.id).toBe(batch.id);
      expect(execution?.completedWaitpoints.length).toBe(3);

      const completedWaitpoint0 = execution?.completedWaitpoints.find((w) => w.index === 0);
      assertNonNullable(completedWaitpoint0);
      expect(completedWaitpoint0.id).toBe(child1Waitpoint!.waitpointId);
      expect(completedWaitpoint0.completedByTaskRun?.id).toBe(child1.id);
      expect(completedWaitpoint0.completedByTaskRun?.batch?.id).toBe(batch.id);
      expect(completedWaitpoint0.output).toBe('{"foo":"bar"}');
      expect(completedWaitpoint0.index).toBe(0);

      const completedWaitpoint1 = execution?.completedWaitpoints.find((w) => w.index === 1);
      assertNonNullable(completedWaitpoint1);
      expect(completedWaitpoint1.id).toBe(child2Waitpoint!.waitpointId);
      expect(completedWaitpoint1.completedByTaskRun?.id).toBe(child2.id);
      expect(completedWaitpoint1.completedByTaskRun?.batch?.id).toBe(batch.id);
      expect(completedWaitpoint1.index).toBe(1);
      expect(completedWaitpoint1.output).toBe('{"baz":"qux"}');

      const batchWaitpointAfter = execution?.completedWaitpoints.find((w) => w.type === "BATCH");
      expect(batchWaitpointAfter?.id).toBe(batchWaitpoint?.waitpointId);
      expect(batchWaitpointAfter?.completedByBatch?.id).toBe(batch.id);
      expect(batchWaitpointAfter?.index).toBeUndefined();

      const batchAfter = await prisma.batchTaskRun.findUnique({
        where: {
          id: batch.id,
        },
      });
      expect(batchAfter?.status === "COMPLETED");
    } finally {
      engine.quit();
    }
  });
});
