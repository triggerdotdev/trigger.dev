import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import {
  RedisSnapshotStore,
  SnapshotWriteUnavailableError,
  snapshotKeys,
  type SnapshotStoreDial,
} from "@internal/run-store";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "node:timers/promises";
import type { EventBusEventArgs } from "../eventBus.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { generateFriendlyId, generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import type { RunExecutionData } from "@trigger.dev/core/v3";
import { Decimal, type Prisma, PrismaClient } from "@trigger.dev/database";
import {
  dequeueAndStart,
  makeEngine,
  suspendWithStateHeldCheckpoint,
  triggerRun,
} from "./utils/storeRunWaitpointLifecycleFixtures.js";
import { getLatestExecutionSnapshot } from "../systems/executionSnapshotSystem.js";
import { cycleAnchorSnapshotId } from "../systems/waitpointSystem.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import { encodeCheckpointMetadata } from "../checkpointMetadata.js";

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
        baseCostInCents: 0.0005,
      },
      tracer: trace.getTracer("test", "0.0.0"),
    });

    try {
      const taskIdentifier = "test-task";

      // Create background worker
      const _backgroundWorker = await setupBackgroundWorker(
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
          workerQueue: "main",
          queue: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );

      // Dequeue the run
      await setTimeout(500);
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      expect(dequeued.length).toBe(1);
      assertNonNullable(dequeued[0]);

      // Create an attempt
      const _attemptResult = await engine.startRunAttempt({
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
      const dequeuedAgain = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      expect(dequeuedAgain.length).toBe(1);
      assertNonNullable(dequeuedAgain[0]);

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
        baseCostInCents: 0.0005,
      },
      tracer: trace.getTracer("test", "0.0.0"),
    });

    try {
      const taskIdentifier = "test-task";

      // Create background worker
      const _backgroundWorker = await setupBackgroundWorker(
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
          workerQueue: "main",
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
        baseCostInCents: 0.0005,
      },
      tracer: trace.getTracer("test", "0.0.0"),
    });

    try {
      const taskIdentifier = "test-task";
      const _backgroundWorker = await setupBackgroundWorker(
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
          workerQueue: "main",
          queue: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );

      await setTimeout(500);

      // First checkpoint sequence
      const dequeued1 = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      expect(dequeued1.length).toBe(1);
      assertNonNullable(dequeued1[0]);

      const _attemptResult1 = await engine.startRunAttempt({
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
      const dequeued2 = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      expect(dequeued2.length).toBe(1);
      assertNonNullable(dequeued2[0]);

      // Continue execution from first checkpoint
      const _continueResult1 = await engine.continueRunExecution({
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

      await setTimeout(1000);

      // Dequeue again after second waitpoint completion
      const dequeued3 = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      expect(dequeued3.length).toBe(1);
      assertNonNullable(dequeued3[0]);

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
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        // Create background worker
        const _backgroundWorker = await setupBackgroundWorker(
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
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        await setTimeout(500);

        // Dequeue the run
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(1);
        assertNonNullable(dequeued[0]);

        // Create an attempt
        const _attemptResult = await engine.startRunAttempt({
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
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        // Create background worker
        const _backgroundWorker = await setupBackgroundWorker(
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
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        await setTimeout(500);

        // Dequeue the run
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(1);
        assertNonNullable(dequeued[0]);

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
          workerQueue: "main",
          queue: `task/${parentTask}`,
          isTest: false,
          tags: [],
        },
        prisma
      );

      await setTimeout(500);

      //dequeue parent
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      expect(dequeued.length).toBe(1);
      assertNonNullable(dequeued[0]);

      //create an attempt
      const initialExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
      assertNonNullable(initialExecutionData);
      const _attemptResult = await engine.startRunAttempt({
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
          workerQueue: "main",
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
          workerQueue: "main",
          queue: `task/${childTask}`,
          isTest: false,
          tags: [],
          resumeParentOnCompletion: true,
          parentTaskRunId: parentRun.id,
          batch: { id: batch.id, index: 1 },
        },
        prisma
      );

      await setTimeout(500);

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
      const dequeuedChild = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      expect(dequeuedChild.length).toBe(1);
      assertNonNullable(dequeuedChild[0]);

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

      await setTimeout(1000);

      //dequeue and start the 2nd child
      const dequeuedChild2 = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      expect(dequeuedChild2.length).toBe(1);
      assertNonNullable(dequeuedChild2[0]);

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

      await setTimeout(500);

      // Dequeue the run
      const dequeuedParentAfterCheckpoint = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
      });
      expect(dequeuedParentAfterCheckpoint.length).toBe(1);
      assertNonNullable(dequeuedParentAfterCheckpoint[0]);

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
      await engine.quit();
    }
  });
});

describe("RunEngine checkpoints carried by a MemoryDB-only run's snapshots", () => {
  type Env = Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>;

  const checkpointInput = (location: string) => ({
    type: "KUBERNETES" as const,
    reason: "TEST_CHECKPOINT",
    location,
    imageRef: "test-image-ref",
  });

  const statusAndCheckpoint = (snapshots: RunExecutionData[] | null) =>
    (snapshots ?? []).map((s) => [s.snapshot.executionStatus, s.checkpoint?.id ?? "none"]);

  async function harness(prisma: PrismaClient, redisOptions: any) {
    const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const snapshotStore = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const engine = makeEngine(prisma, redisOptions, { snapshotStore });
    await setupBackgroundWorker(engine, env, "test-task");
    return { env, snapshotStore, engine };
  }

  // A MemoryDB-only run, started and blocked on a manual token.
  async function startAndBlock(
    engine: RunEngine,
    env: Env,
    prisma: PrismaClient,
    store: RedisSnapshotStore
  ) {
    const run = await triggerRun(engine, env, prisma, {
      friendlyId: generateFriendlyId("run"),
      taskIdentifier: "test-task",
    });
    expect(await store.readBirthResidency(run.id)).toBe("redis-primary");
    expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(0);
    await dequeueAndStart(engine, `consumer_${run.id}`);
    return { run, ...(await block(engine, env, run.id)) };
  }

  async function block(engine: RunEngine, env: Env, runId: string) {
    const token = await engine.createManualWaitpoint({
      environmentId: env.id,
      projectId: env.projectId,
    });
    const wait = await engine.blockRunWithWaitpoint({
      runId,
      waitpoints: token.waitpoint.id,
      projectId: env.projectId,
      organizationId: env.organizationId,
    });
    expect(wait.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
    return { tokenId: token.waitpoint.id, wait };
  }

  async function suspend(engine: RunEngine, runId: string, snapshotId: string, location: string) {
    const result = await engine.createCheckpoint({
      runId,
      snapshotId,
      checkpoint: checkpointInput(location),
    });
    if (!result.ok) throw new Error(result.error);
    return result;
  }

  async function dequeueRestore(engine: RunEngine, env: Env) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "restore_consumer",
        workerQueue: "main",
      });
      if (dequeued.length > 0) return dequeued[0]!;
      await setTimeout(200);
    }
    throw new Error("restore never reached the worker queue");
  }

  // Catches: a checkpoint carried into a snapshot that should not have one, or a window that gives
  // every snapshot the same checkpoint.
  containerTest(
    "each snapshot carries its own checkpoint across two suspends, and none after continue or finish",
    async ({ prisma, redisOptions }) => {
      const { env, snapshotStore, engine } = await harness(prisma, redisOptions);
      try {
        const {
          run,
          tokenId: token1,
          wait: wait1,
        } = await startAndBlock(engine, env, prisma, snapshotStore);
        const c1 = (await suspend(engine, run.id, wait1.id, "loc-1")).checkpoint.id;
        await engine.completeWaitpoint({ id: token1 });
        const restore1 = await dequeueRestore(engine, env);
        expect(restore1.checkpoint?.id).toBe(c1);
        await engine.continueRunExecution({ runId: run.id, snapshotId: restore1.snapshot.id });

        const { tokenId: token2, wait: wait2 } = await block(engine, env, run.id);
        const c2 = (await suspend(engine, run.id, wait2.id, "loc-2")).checkpoint.id;

        expect(
          statusAndCheckpoint(
            await engine.getSnapshotsSince({ runId: run.id, snapshotId: wait1.id })
          )
        ).toEqual([
          ["SUSPENDED", c1],
          ["QUEUED", c1],
          ["PENDING_EXECUTING", c1],
          ["EXECUTING", "none"],
          ["EXECUTING_WITH_WAITPOINTS", "none"],
          ["SUSPENDED", c2],
        ]);
        const latest = await engine.getRunExecutionData({ runId: run.id });
        expect(latest?.checkpoint?.location).toBe("loc-2");

        await engine.completeWaitpoint({ id: token2 });
        const restore2 = await dequeueRestore(engine, env);
        expect(restore2.checkpoint?.id).toBe(c2);
        const continued = await engine.continueRunExecution({
          runId: run.id,
          snapshotId: restore2.snapshot.id,
        });
        await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: continued.snapshot.id,
          completion: { id: run.id, ok: true, output: "{}", outputType: "application/json" },
        });
        expect(
          statusAndCheckpoint(
            await engine.getSnapshotsSince({ runId: run.id, snapshotId: wait2.id })
          )
        ).toEqual([
          ["SUSPENDED", c2],
          ["QUEUED", c2],
          ["PENDING_EXECUTING", c2],
          ["EXECUTING", "none"],
          ["FINISHED", "none"],
        ]);
        expect(await prisma.taskRunExecutionSnapshot.count({ where: { runId: run.id } })).toBe(0);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  // Catches: a cancel of a restore carrying the checkpoint into PENDING_CANCEL.
  containerTest(
    "a cancel of a restore's PENDING_EXECUTING snapshot writes PENDING_CANCEL with no checkpoint",
    async ({ prisma, redisOptions }) => {
      const { env, snapshotStore, engine } = await harness(prisma, redisOptions);
      try {
        const { run, tokenId, wait } = await startAndBlock(engine, env, prisma, snapshotStore);
        const c1 = (await suspend(engine, run.id, wait.id, "loc-1")).checkpoint.id;
        await engine.completeWaitpoint({ id: tokenId });
        const restore = await dequeueRestore(engine, env);
        expect(restore.snapshot.executionStatus).toBe("PENDING_EXECUTING");
        expect(restore.checkpoint?.id).toBe(c1);

        const cancelled = await engine.cancelRun({ runId: run.id });
        expect(cancelled.snapshot.executionStatus).toBe("PENDING_CANCEL");
        expect(
          statusAndCheckpoint(
            await engine.getSnapshotsSince({ runId: run.id, snapshotId: restore.snapshot.id })
          )
        ).toEqual([["PENDING_CANCEL", "none"]]);
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  // Catches: the invalid-state dequeue snapshot dropping the run's checkpoint.
  containerTest(
    "a dequeue that finds a run in a state it cannot dequeue keeps its checkpoint and fails the run",
    async ({ prisma, redisOptions }) => {
      const { env, snapshotStore, engine } = await harness(prisma, redisOptions);
      try {
        const { run, tokenId, wait } = await startAndBlock(engine, env, prisma, snapshotStore);
        const c1 = (await suspend(engine, run.id, wait.id, "loc-1")).checkpoint.id;
        await engine.completeWaitpoint({ id: tokenId });

        let queued = await engine.getRunExecutionData({ runId: run.id });
        for (let i = 0; i < 80 && queued?.snapshot.executionStatus !== "QUEUED"; i++) {
          await setTimeout(250);
          queued = await engine.getRunExecutionData({ runId: run.id });
        }
        assertNonNullable(queued);
        expect(queued.snapshot.executionStatus).toBe("QUEUED");
        expect(queued.checkpoint?.id).toBe(c1);
        await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);

        const written = await engine.executionSnapshotSystem.createExecutionSnapshot(prisma, {
          run: {
            id: run.id,
            status: queued.run.status,
            attemptNumber: queued.run.attemptNumber,
          },
          snapshot: { executionStatus: "SUSPENDED", description: "Suspended again before dequeue" },
          previousSnapshotId: queued.snapshot.id,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.projectId,
          organizationId: env.organizationId,
          checkpointId: c1,
        });

        const deadline = Date.now() + 20_000;
        let status = "";
        while (Date.now() < deadline) {
          await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);
          const dequeued = await engine.dequeueFromWorkerQueue({
            consumerId: "invalid_state_consumer",
            workerQueue: "main",
          });
          expect(dequeued).toEqual([]);
          status = (await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } })).status;
          if (status !== "PENDING" && status !== "WAITING_TO_RESUME") break;
          await setTimeout(200);
        }

        // The invalid-state snapshot carries an error, so it is not valid: the since window (valid
        // snapshots only) skips it, and both it and the FINISHED snapshot follow the one written
        // above. Both are read from the run's MemoryDB entries.
        const since = await engine.getSnapshotsSince({ runId: run.id, snapshotId: written.id });
        expect(statusAndCheckpoint(since)).toEqual([["FINISHED", "none"]]);
        const raw = createRedisClient(redisOptions, { onError: () => {} });
        try {
          const fields = await raw.hgetall(snapshotKeys(run.id).e);
          const entries = Object.entries(fields)
            .filter(([field]) => !field.includes("#"))
            .map(([, value]) => JSON.parse(value))
            .filter((e) => e.previousSnapshotId === written.id)
            .map((e) => [e.executionStatus, e.error !== undefined, e.checkpointId ?? "none"]);
          expect(entries.sort()).toEqual([
            ["FINISHED", false, "none"],
            ["SUSPENDED", true, c1],
          ]);
        } finally {
          await raw.quit();
        }
        const failed = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect((failed.error as { code?: string } | null)?.code).toBe(
          "TASK_DEQUEUED_INVALID_STATE"
        );
        expect(failed.status).toBe("SYSTEM_FAILURE");
      } finally {
        await engine.quit();
        await snapshotStore.quit();
      }
    }
  );

  describe("with a state-held checkpoint", () => {
    const BIRTH_QUEUE = "us-east-1:v2:scheduled:fresh:any:stable";
    const RESTORE_QUEUE = "us-east-1:v2:scheduled:restore:container:stable";
    const WRONG_QUEUE = "us-east-1:v2:scheduled:restore:compute:stable";
    const STATE_HELD = {
      type: "KUBERNETES" as const,
      location: "state-loc-1",
      imageRef: "state-image-ref",
      reason: "TEST_STATE_HELD",
    };
    type Seeded = Awaited<ReturnType<typeof suspendWithStateHeldCheckpoint>>["checkpoint"];

    async function dequeueFrom(engine: RunEngine, env: Env, workerQueue: string) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "state_held_consumer",
          workerQueue,
          blockingPop: false,
        });
        if (dequeued.length > 0) return dequeued[0]!;
        await setTimeout(200);
      }
      throw new Error(`nothing reached ${workerQueue}`);
    }

    async function queueStateHeld(
      engine: RunEngine,
      env: Env,
      prisma: PrismaClient,
      store: RedisSnapshotStore
    ) {
      const friendlyId = generateFriendlyId("run");
      const run = await engine.trigger(
        {
          number: 1,
          friendlyId,
          environment: env,
          taskIdentifier: "test-task",
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: `t_${friendlyId}`,
          spanId: `s_${friendlyId}`,
          workerQueue: BIRTH_QUEUE,
          queue: "task/test-task",
          isTest: false,
          tags: [],
        },
        prisma
      );
      expect(await store.readBirthResidency(run.id)).toBe("redis-primary");
      const first = await dequeueFrom(engine, env, BIRTH_QUEUE);
      await engine.startRunAttempt({ runId: run.id, snapshotId: first.snapshot.id });
      const { tokenId, wait } = await block(engine, env, run.id);
      const { checkpoint } = await suspendWithStateHeldCheckpoint(
        engine,
        prisma,
        run.id,
        wait.id,
        STATE_HELD
      );
      expect(await prisma.taskRunCheckpoint.count({ where: { id: checkpoint.id } })).toBe(0);
      await engine.completeWaitpoint({ id: tokenId });

      let queued = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
      for (let i = 0; i < 80 && queued.executionStatus !== "QUEUED"; i++) {
        await setTimeout(250);
        queued = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
      }
      expect(queued.executionStatus).toBe("QUEUED");
      return { run, wait, checkpoint, queued };
    }

    async function restoreStateHeld(
      engine: RunEngine,
      env: Env,
      prisma: PrismaClient,
      store: RedisSnapshotStore
    ) {
      const queued = await queueStateHeld(engine, env, prisma, store);
      const restore = await dequeueFrom(engine, env, RESTORE_QUEUE);
      return { ...queued, restore };
    }

    async function expectCarried(
      engine: RunEngine,
      prisma: PrismaClient,
      runId: string,
      status: string,
      checkpoint: Seeded
    ) {
      const read = await getLatestExecutionSnapshot(prisma, runId, engine.runStore);
      expect(read.executionStatus).toBe(status);
      expect(read.checkpointStore).toBe("state");
      expect(read.checkpointId).toBe(checkpoint.id);
      expect(read.checkpoint?.id).toBe(checkpoint.id);
      expect(read.checkpoint?.location).toBe(checkpoint.location);
      expect(await prisma.taskRunCheckpoint.count({ where: { id: checkpoint.id } })).toBe(0);
      return read;
    }

    async function rawHead(store: RedisSnapshotStore, runId: string) {
      return (await store.getLatest(runId))!.entry;
    }

    // The latest snapshot refers to Postgres checkpoint `checkpointId` (at "pg-loc-1") with no record.
    async function expectPostgresCarried(
      engine: RunEngine,
      prisma: PrismaClient,
      store: RedisSnapshotStore,
      runId: string,
      status: string,
      checkpointId: string
    ) {
      const head = await rawHead(store, runId);
      expect(head.executionStatus).toBe(status);
      expect(head.checkpointId).toBe(checkpointId);
      expect("checkpointStore" in head).toBe(false);
      const read = await getLatestExecutionSnapshot(prisma, runId, engine.runStore);
      expect(read.checkpoint?.id).toBe(checkpointId);
      expect(read.checkpoint?.location).toBe("pg-loc-1");
      expect("checkpointStore" in read).toBe(false);
      return read;
    }

    // Catches: resume or the dequeue lock dropping a state-held checkpoint's record, a restore
    // published to the wrong lane, or continue keeping the record.
    containerTest(
      "resume carries a state-held checkpoint to QUEUED, the lock carries it to PENDING_EXECUTING, and continue drops it",
      async ({ prisma, redisOptions }) => {
        const { env, snapshotStore, engine } = await harness(prisma, redisOptions);
        try {
          const { run, wait, checkpoint } = await queueStateHeld(
            engine,
            env,
            prisma,
            snapshotStore
          );
          await expectCarried(engine, prisma, run.id, "QUEUED", checkpoint);

          await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);
          const message = await engine.runQueue.readMessage(env.organizationId, run.id);
          assertNonNullable(message);
          expect(message).toMatchObject({ workerQueue: RESTORE_QUEUE });
          const dequeue = (workerQueue: string) =>
            engine.dequeueFromWorkerQueue({
              consumerId: "state_held_consumer",
              workerQueue,
              blockingPop: false,
            });
          expect(await dequeue(WRONG_QUEUE)).toEqual([]);
          expect(await dequeue(BIRTH_QUEUE)).toEqual([]);

          const restore = await dequeueFrom(engine, env, RESTORE_QUEUE);
          expect(restore.checkpoint).toMatchObject({
            id: checkpoint.id,
            friendlyId: checkpoint.friendlyId,
            type: "KUBERNETES",
            location: checkpoint.location,
            imageRef: checkpoint.imageRef,
            reason: checkpoint.reason,
          });
          await expectCarried(engine, prisma, run.id, "PENDING_EXECUTING", checkpoint);
          expect(
            statusAndCheckpoint(
              await engine.getSnapshotsSince({ runId: run.id, snapshotId: wait.id })
            )
          ).toEqual([
            ["SUSPENDED", checkpoint.id],
            ["QUEUED", checkpoint.id],
            ["PENDING_EXECUTING", checkpoint.id],
          ]);

          const continued = await engine.continueRunExecution({
            runId: run.id,
            snapshotId: restore.snapshot.id,
          });
          expect(continued.snapshot.executionStatus).toBe("EXECUTING");
          const head = await rawHead(snapshotStore, run.id);
          expect(head.executionStatus).toBe("EXECUTING");
          expect("checkpointId" in head).toBe(false);
          expect("checkpointStore" in head).toBe(false);
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );

    // Catches: a restore outcome requeue dropping the record, so the next restore has no checkpoint.
    containerTest(
      "a restore outcome requeue keeps the state-held checkpoint",
      async ({ prisma, redisOptions }) => {
        const { env, snapshotStore, engine } = await harness(prisma, redisOptions);
        try {
          const { run, checkpoint, restore } = await restoreStateHeld(
            engine,
            env,
            prisma,
            snapshotStore
          );
          expect(
            await engine.reportRestoreOutcome({
              runId: run.id,
              snapshotId: restore.snapshot.id,
              outcome: "requeue",
              reason: "NodeBusy",
            })
          ).toEqual({ ok: true, outcome: "requeue" });
          await expectCarried(engine, prisma, run.id, "QUEUED", checkpoint);
          const next = await dequeueFrom(engine, env, RESTORE_QUEUE);
          expect(next.checkpoint?.id).toBe(checkpoint.id);
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );

    // Catches: a release before start dropping the record, so the next restore has no checkpoint.
    containerTest(
      "a release before start keeps the state-held checkpoint",
      async ({ prisma, redisOptions }) => {
        const { env, snapshotStore, engine } = await harness(prisma, redisOptions);
        try {
          const { run, checkpoint, restore } = await restoreStateHeld(
            engine,
            env,
            prisma,
            snapshotStore
          );
          expect(
            await engine.releaseRun({
              runId: run.id,
              snapshotId: restore.snapshot.id,
              reason: "not started",
            })
          ).toEqual({ ok: true, requeued: true });
          await expectCarried(engine, prisma, run.id, "QUEUED", checkpoint);
          const next = await dequeueFrom(engine, env, RESTORE_QUEUE);
          expect(next.checkpoint?.id).toBe(checkpoint.id);
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );

    // Catches: the failed-dequeue recovery requeueing without the record.
    containerTest(
      "a failed dequeue that is recovered keeps the state-held checkpoint",
      async ({ prisma, redisOptions }) => {
        const { env, snapshotStore, engine } = await harness(prisma, redisOptions);
        try {
          const { run, checkpoint, queued } = await queueStateHeld(
            engine,
            env,
            prisma,
            snapshotStore
          );
          await expect
            .poll(async () => {
              await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);
              return (await engine.runQueue.peekAllOnWorkerQueue(RESTORE_QUEUE)).length;
            })
            .toBe(1);

          engine.eventBus.once("runLocked", () => {
            throw new Error("Restore preparation failed after locking the run");
          });
          expect(
            await engine.dequeueFromWorkerQueue({
              consumerId: "state_held_consumer",
              workerQueue: RESTORE_QUEUE,
              blockingPop: false,
            })
          ).toEqual([]);
          const recovered = await expectCarried(engine, prisma, run.id, "QUEUED", checkpoint);
          expect(recovered.id).not.toBe(queued.id);
          const next = await dequeueFrom(engine, env, RESTORE_QUEUE);
          expect(next.checkpoint?.id).toBe(checkpoint.id);
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );

    // Catches: the invalid-state dequeue snapshot dropping the record, so its checkpoint reads null.
    containerTest(
      "a dequeue that finds a run in a state it cannot dequeue keeps the state-held checkpoint and fails the run",
      async ({ prisma, redisOptions }) => {
        const { env, snapshotStore, engine } = await harness(prisma, redisOptions);
        try {
          const { run, checkpoint, queued } = await queueStateHeld(
            engine,
            env,
            prisma,
            snapshotStore
          );
          await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);

          const written = await engine.executionSnapshotSystem.createExecutionSnapshot(prisma, {
            run: { id: run.id, status: queued.runStatus, attemptNumber: queued.attemptNumber },
            snapshot: {
              executionStatus: "SUSPENDED",
              description: "Suspended again before dequeue",
            },
            previousSnapshotId: queued.id,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
            checkpointId: checkpoint.id,
            checkpointStore: "state",
          });

          const deadline = Date.now() + 20_000;
          let status = "";
          while (Date.now() < deadline) {
            await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);
            const dequeued = await engine.dequeueFromWorkerQueue({
              consumerId: "state_held_consumer",
              workerQueue: RESTORE_QUEUE,
              blockingPop: false,
            });
            expect(dequeued).toEqual([]);
            status = (await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } })).status;
            if (status !== "PENDING" && status !== "WAITING_TO_RESUME") break;
            await setTimeout(200);
          }

          const raw = createRedisClient(redisOptions, { onError: () => {} });
          let invalidId: string | undefined;
          try {
            const fields = await raw.hgetall(snapshotKeys(run.id).e);
            const entries = Object.entries(fields)
              .filter(([field]) => !field.includes("#"))
              .map(([field, value]) => [field, JSON.parse(value)] as const)
              .filter(([, e]) => e.previousSnapshotId === written.id);
            invalidId = entries.find(([, e]) => e.executionStatus === "SUSPENDED")?.[0];
            expect(
              entries
                .map(([, e]) => [
                  e.executionStatus,
                  e.error !== undefined,
                  e.checkpointId ?? "none",
                  e.checkpointStore ?? "none",
                ])
                .sort()
            ).toEqual([
              ["FINISHED", false, "none", "none"],
              ["SUSPENDED", true, checkpoint.id, "state"],
            ]);
          } finally {
            await raw.quit();
          }
          assertNonNullable(invalidId);

          // The declared type has neither field; the MemoryDB read returns both.
          const byId = (await engine.runStore.findExecutionSnapshot(
            { where: { id: invalidId, runId: run.id } },
            undefined,
            { version: 1, residency: "redis-primary", organizationId: env.organizationId }
          )) as {
            checkpointStore?: string;
            checkpoint: { id: string; location: string } | null;
          } | null;
          expect(byId?.checkpointStore).toBe("state");
          expect(byId?.checkpoint?.id).toBe(checkpoint.id);
          expect(byId?.checkpoint?.location).toBe(checkpoint.location);

          const since = await engine.getSnapshotsSince({ runId: run.id, snapshotId: written.id });
          expect(statusAndCheckpoint(since)).toEqual([["FINISHED", "none"]]);
          const failed = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
          expect(failed.status).toBe("SYSTEM_FAILURE");
          expect((failed.error as { code?: string } | null)?.code).toBe(
            "TASK_DEQUEUED_INVALID_STATE"
          );
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );

    // Catches: a retry from scratch carrying the record (or the checkpoint) of the failed restore.
    containerTest(
      "a restore outcome fail retries from scratch with no checkpoint and no record",
      async ({ prisma, redisOptions }) => {
        const { env, snapshotStore, engine } = await harness(prisma, redisOptions);
        try {
          const { run, restore } = await restoreStateHeld(engine, env, prisma, snapshotStore);
          expect(
            await engine.reportRestoreOutcome({
              runId: run.id,
              snapshotId: restore.snapshot.id,
              outcome: "fail",
              reason: "SnapshotNotFound",
            })
          ).toEqual({ ok: true, outcome: "fail" });
          const head = await rawHead(snapshotStore, run.id);
          expect(head.executionStatus).toBe("QUEUED");
          expect("checkpointId" in head).toBe(false);
          expect("checkpointStore" in head).toBe(false);
          const read = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
          expect(read.checkpoint).toBeNull();
          const retry = await dequeueFrom(engine, env, BIRTH_QUEUE);
          expect(retry.checkpoint).toBeUndefined();
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );

    // Catches: a cancel carrying the record (or the checkpoint) of the restore it cancels.
    containerTest(
      "a cancel of a state-held restore writes PENDING_CANCEL with no checkpoint and no record",
      async ({ prisma, redisOptions }) => {
        const { env, snapshotStore, engine } = await harness(prisma, redisOptions);
        try {
          const { run, checkpoint } = await restoreStateHeld(engine, env, prisma, snapshotStore);
          await expectCarried(engine, prisma, run.id, "PENDING_EXECUTING", checkpoint);

          const cancelled = await engine.cancelRun({ runId: run.id });
          expect(cancelled.snapshot?.executionStatus).toBe("PENDING_CANCEL");
          const head = await rawHead(snapshotStore, run.id);
          expect(head.executionStatus).toBe("PENDING_CANCEL");
          expect("checkpointId" in head).toBe(false);
          expect("checkpointStore" in head).toBe(false);
          const read = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
          expect(read.checkpoint).toBeNull();
          expect("checkpointStore" in read).toBe(false);
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );

    // Catches: a record added to a Postgres checkpoint's snapshots, which would read it from the state.
    containerTest(
      "a Postgres checkpoint is carried with no record through resume, dequeue, requeue and release",
      async ({ prisma, redisOptions }) => {
        const { env, snapshotStore, engine } = await harness(prisma, redisOptions);
        try {
          const { run, tokenId, wait } = await startAndBlock(engine, env, prisma, snapshotStore);
          const c = (await suspend(engine, run.id, wait.id, "pg-loc-1")).checkpoint;
          expect(await prisma.taskRunCheckpoint.count({ where: { id: c.id } })).toBe(1);

          const expectPostgres = (status: string) =>
            expectPostgresCarried(engine, prisma, snapshotStore, run.id, status, c.id);

          await engine.completeWaitpoint({ id: tokenId });
          let queued = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
          for (let i = 0; i < 80 && queued.executionStatus !== "QUEUED"; i++) {
            await setTimeout(250);
            queued = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
          }
          await expectPostgres("QUEUED");

          const restore = await dequeueRestore(engine, env);
          expect(restore.checkpoint?.id).toBe(c.id);
          await expectPostgres("PENDING_EXECUTING");

          expect(
            await engine.reportRestoreOutcome({
              runId: run.id,
              snapshotId: restore.snapshot.id,
              outcome: "requeue",
              reason: "NodeBusy",
            })
          ).toEqual({ ok: true, outcome: "requeue" });
          await expectPostgres("QUEUED");

          const next = await dequeueRestore(engine, env);
          expect(next.checkpoint?.id).toBe(c.id);
          await expectPostgres("PENDING_EXECUTING");

          expect(
            await engine.releaseRun({
              runId: run.id,
              snapshotId: next.snapshot.id,
              reason: "not started",
            })
          ).toEqual({ ok: true, requeued: true });
          await expectPostgres("QUEUED");
          const last = await dequeueRestore(engine, env);
          expect(last.checkpoint?.id).toBe(c.id);
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );

    // Catches: a record added to a Postgres checkpoint's snapshot by the failed-dequeue recovery or
    // the invalid-state dequeue.
    containerTest(
      "a Postgres checkpoint is carried with no record through a recovered failed dequeue and an invalid-state dequeue",
      async ({ prisma, redisOptions }) => {
        const { env, snapshotStore, engine } = await harness(prisma, redisOptions);
        try {
          const { run, tokenId, wait } = await startAndBlock(engine, env, prisma, snapshotStore);
          const c = (await suspend(engine, run.id, wait.id, "pg-loc-1")).checkpoint;
          expect(await prisma.taskRunCheckpoint.count({ where: { id: c.id } })).toBe(1);

          await engine.completeWaitpoint({ id: tokenId });
          let queued = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
          for (let i = 0; i < 80 && queued.executionStatus !== "QUEUED"; i++) {
            await setTimeout(250);
            queued = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
          }
          await expectPostgresCarried(engine, prisma, snapshotStore, run.id, "QUEUED", c.id);

          // Path 6: the lock succeeds, then the dequeue fails and the recovery requeues the run.
          await expect
            .poll(async () => {
              await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);
              return (await engine.runQueue.peekAllOnWorkerQueue("main")).length;
            })
            .toBe(1);
          engine.eventBus.once("runLocked", () => {
            throw new Error("Restore preparation failed after locking the run");
          });
          expect(
            await engine.dequeueFromWorkerQueue({
              consumerId: "restore_consumer",
              workerQueue: "main",
              blockingPop: false,
            })
          ).toEqual([]);
          const recovered = await expectPostgresCarried(
            engine,
            prisma,
            snapshotStore,
            run.id,
            "QUEUED",
            c.id
          );
          expect(recovered.id).not.toBe(queued.id);

          // Path 7: a SUSPENDED snapshot written after the recovery makes the next dequeue invalid.
          await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);
          const written = await engine.executionSnapshotSystem.createExecutionSnapshot(prisma, {
            run: {
              id: run.id,
              status: recovered.runStatus,
              attemptNumber: recovered.attemptNumber,
            },
            snapshot: {
              executionStatus: "SUSPENDED",
              description: "Suspended again before dequeue",
            },
            previousSnapshotId: recovered.id,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
            checkpointId: c.id,
          });

          const deadline = Date.now() + 20_000;
          let status = "";
          while (Date.now() < deadline) {
            await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);
            const dequeued = await engine.dequeueFromWorkerQueue({
              consumerId: "restore_consumer",
              workerQueue: "main",
              blockingPop: false,
            });
            expect(dequeued).toEqual([]);
            status = (await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } })).status;
            if (status !== "PENDING" && status !== "WAITING_TO_RESUME") break;
            await setTimeout(200);
          }

          const raw = createRedisClient(redisOptions, { onError: () => {} });
          let invalidId: string | undefined;
          try {
            const fields = await raw.hgetall(snapshotKeys(run.id).e);
            const entries = Object.entries(fields)
              .filter(([field]) => !field.includes("#"))
              .map(([field, value]) => [field, JSON.parse(value)] as const)
              .filter(([, e]) => e.previousSnapshotId === written.id);
            invalidId = entries.find(([, e]) => e.executionStatus === "SUSPENDED")?.[0];
            expect(
              entries
                .map(([, e]) => [
                  e.executionStatus,
                  e.checkpointId ?? "none",
                  "checkpointStore" in e ? e.checkpointStore : "none",
                ])
                .sort()
            ).toEqual([
              ["FINISHED", "none", "none"],
              ["SUSPENDED", c.id, "none"],
            ]);
          } finally {
            await raw.quit();
          }
          assertNonNullable(invalidId);

          // The declared type has neither field; the MemoryDB read returns the checkpoint.
          const byId = (await engine.runStore.findExecutionSnapshot(
            { where: { id: invalidId, runId: run.id } },
            undefined,
            { version: 1, residency: "redis-primary", organizationId: env.organizationId }
          )) as {
            checkpointStore?: string;
            checkpoint: { id: string; location: string } | null;
          } | null;
          assertNonNullable(byId);
          expect("checkpointStore" in byId).toBe(false);
          expect(byId.checkpoint?.id).toBe(c.id);
          expect(byId.checkpoint?.location).toBe("pg-loc-1");
          const failed = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
          expect(failed.status).toBe("SYSTEM_FAILURE");
        } finally {
          await engine.quit();
          await snapshotStore.quit();
        }
      }
    );

    describe("with checkpointStoreEnabled", () => {
      const FLAGGED = {
        type: "KUBERNETES" as const,
        location: "flagged-loc-1",
        imageRef: "flagged-image-ref",
        reason: "TEST_FLAGGED",
        digest: `sha256:${"ab".repeat(32)}`,
      };
      const ROW_KEYS = [
        "createdAt",
        "friendlyId",
        "id",
        "imageRef",
        "location",
        "metadata",
        "projectId",
        "reason",
        "runtimeEnvironmentId",
        "type",
        "updatedAt",
      ];

      function checkpointFlag(initial: boolean | Error) {
        let value = initial;
        const calls: string[] = [];
        return {
          calls,
          set(next: boolean | Error) {
            value = next;
          },
          resolve: async (organizationId: string) => {
            calls.push(organizationId);
            if (value instanceof Error) throw value;
            return value;
          },
        };
      }

      class CheckpointWriteStore extends RedisSnapshotStore {
        writes = 0;
        fail: "throw" | "false" | undefined;

        override async writeCheckpoint(runId: string, checkpointId: string, raw: string) {
          this.writes++;
          if (this.fail === "throw") throw new Error("checkpoint write failed in test");
          if (this.fail === "false") return false;
          return super.writeCheckpoint(runId, checkpointId, raw);
        }
      }

      async function flagged(
        prisma: PrismaClient,
        redisOptions: any,
        flag: { resolve: (organizationId: string) => Promise<boolean> },
        opts?: {
          dial?: () => SnapshotStoreDial;
          waitpointStore?: WaitpointStoreCoordinator;
          env?: Env;
        }
      ) {
        const env = opts?.env ?? (await setupAuthenticatedEnvironment(prisma, "PRODUCTION"));
        const snapshotStore = new CheckpointWriteStore({ redisOptions, completedTtlMs: 60_000 });
        const engine = makeEngine(prisma, redisOptions, {
          snapshotStore,
          resolveDial: opts?.dial,
          isCheckpointStoreEnabled: flag.resolve,
          ...(opts?.waitpointStore ? { store: opts.waitpointStore, enabled: true } : {}),
        });
        await setupBackgroundWorker(engine, env, "test-task");
        return { env, snapshotStore, engine };
      }

      // The engine returns the stored row; its declared type is the wire shape.
      function accepted(result: Awaited<ReturnType<RunEngine["createCheckpoint"]>>) {
        if (!result.ok) throw new Error(result.error);
        return { ...result, row: result.checkpoint as unknown as Seeded };
      }

      async function startAndBlockOn(
        engine: RunEngine,
        env: Env,
        prisma: PrismaClient,
        store: RedisSnapshotStore,
        workerQueue: string,
        // The birth residency marker; null for a run with none (dial "off").
        residency: string | null = "redis-primary"
      ) {
        const friendlyId = generateFriendlyId("run");
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId,
            environment: env,
            taskIdentifier: "test-task",
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: `t_${friendlyId}`,
            spanId: `s_${friendlyId}`,
            workerQueue,
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );
        expect(await store.readBirthResidency(run.id)).toBe(residency ?? undefined);
        const first = await dequeueFrom(engine, env, workerQueue);
        expect(first.run.id).toBe(run.id);
        const started = await engine.startRunAttempt({
          runId: run.id,
          snapshotId: first.snapshot.id,
        });
        const { tokenId, wait } = await block(engine, env, run.id);
        return { run, started, tokenId, wait };
      }

      async function queuedExecutingOn(
        engine: RunEngine,
        env: Env,
        prisma: PrismaClient,
        store: RedisSnapshotStore,
        workerQueue: string,
        residency?: string | null
      ) {
        const blocked = await startAndBlockOn(engine, env, prisma, store, workerQueue, residency);
        const queuedExecuting = await engine.executionSnapshotSystem.createExecutionSnapshot(
          prisma,
          {
            run: blocked.started.run,
            snapshot: {
              executionStatus: "QUEUED_EXECUTING",
              description: "Checkpoint request is in flight during re-enqueue",
            },
            previousSnapshotId: blocked.wait.id,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.projectId,
            organizationId: env.organizationId,
          }
        );
        return { ...blocked, queuedExecuting };
      }

      async function stateFields(redisOptions: any, runId: string) {
        const raw = createRedisClient(redisOptions, { onError: () => {} });
        try {
          return (await raw.hkeys(snapshotKeys(runId).e)).filter((f) => f.endsWith("#cp")).sort();
        } finally {
          await raw.quit();
        }
      }

      async function secondOrganisationEnvironment(prisma: PrismaClient, first: Env) {
        const org = await prisma.organization.create({
          data: { title: "Test Organization", slug: "test-organization-second" },
        });
        const project = await prisma.project.create({
          data: {
            name: "Test Project",
            slug: "test-project-second",
            externalRef: "proj_1234-second",
            organizationId: org.id,
            defaultWorkerGroupId: first.project.defaultWorkerGroupId,
          },
        });
        const environment = await prisma.runtimeEnvironment.create({
          data: {
            type: "PRODUCTION",
            slug: "slug-second",
            projectId: project.id,
            organizationId: org.id,
            apiKey: "api_key-second",
            pkApiKey: "pk_api_key-second",
            shortcode: "short_code-second",
            maximumConcurrencyLimit: 10,
            concurrencyLimitBurstFactor: new Decimal(2.0),
          },
        });
        return prisma.runtimeEnvironment.findUniqueOrThrow({
          where: { id: environment.id },
          include: { project: true, organization: true, orgMember: true },
        });
      }

      // A PrismaClient whose statements naming "TaskRunCheckpoint" are counted from its query events.
      function checkpointTableCounter(uri: string) {
        const client = new PrismaClient({
          datasources: { db: { url: uri } },
          log: [{ emit: "event", level: "query" }],
        });
        let statements = 0;
        const markers = new Set<string>();
        client.$on("query", (event: Prisma.QueryEvent) => {
          if (event.query.includes('"TaskRunCheckpoint"')) statements++;
          for (const marker of markers) if (event.query.includes(marker)) markers.delete(marker);
        });
        async function settle() {
          const marker = `lookup_marker_${generateInternalId()}`;
          markers.add(marker);
          await client.$queryRawUnsafe(`SELECT 1 AS "${marker}"`);
          for (let i = 0; i < 500 && markers.has(marker); i++) await setTimeout(10);
          expect(markers.has(marker)).toBe(false);
        }
        return { client, settle, count: () => statements };
      }

      async function latestId(engine: RunEngine, prisma: PrismaClient, runId: string) {
        return (await getLatestExecutionSnapshot(prisma, runId, engine.runStore)).id;
      }

      async function untilLatest(
        engine: RunEngine,
        prisma: PrismaClient,
        runId: string,
        status: string
      ) {
        let latest = await getLatestExecutionSnapshot(prisma, runId, engine.runStore);
        for (let i = 0; i < 80 && latest.executionStatus !== status; i++) {
          await setTimeout(250);
          latest = await getLatestExecutionSnapshot(prisma, runId, engine.runStore);
        }
        expect(latest.executionStatus).toBe(status);
        return latest;
      }

      async function runStatus(prisma: PrismaClient, runId: string) {
        return (await prisma.taskRun.findFirstOrThrow({ where: { id: runId } })).status;
      }

      // Catches: a flagged suspend writing its checkpoint to Postgres, a snapshot without the record,
      // more than one lookup, or a restore that cannot find the state-held checkpoint.
      containerTest(
        "a flagged suspend of a waiting run writes its checkpoint into the run's state and the run completes with no checkpoint-table statement",
        async ({ prisma, postgresContainer, redisOptions }) => {
          const counter = checkpointTableCounter(postgresContainer.getConnectionUri());
          const flag = checkpointFlag(true);
          const { env, snapshotStore, engine } = await flagged(counter.client, redisOptions, flag);
          try {
            await counter.settle();
            const before = counter.count();
            const { run, tokenId, wait } = await startAndBlockOn(
              engine,
              env,
              counter.client,
              snapshotStore,
              BIRTH_QUEUE
            );
            expect(flag.calls).toEqual([]);
            expect(await engine.runQueue.currentConcurrencyOfEnvironment(env)).toBe(1);

            const result = accepted(
              await engine.createCheckpoint({
                runId: run.id,
                snapshotId: wait.id,
                checkpoint: FLAGGED,
              })
            );
            expect(result.snapshot.executionStatus).toBe("SUSPENDED");
            expect(flag.calls).toEqual([env.organizationId]);
            const read = await expectCarried(engine, prisma, run.id, "SUSPENDED", result.row);
            expect(read.checkpoint).toEqual(result.checkpoint);
            expect(Object.keys(result.checkpoint).sort()).toEqual(ROW_KEYS);
            expect(result.row.metadata).toBe(encodeCheckpointMetadata(FLAGGED.digest));
            expect(await stateFields(redisOptions, run.id)).toEqual([`${result.row.id}#cp`]);
            expect(snapshotStore.writes).toBe(1);
            expect(await runStatus(prisma, run.id)).toBe("WAITING_TO_RESUME");
            expect(await engine.runQueue.currentConcurrencyOfEnvironment(env)).toBe(0);

            await engine.completeWaitpoint({ id: tokenId });
            await untilLatest(engine, prisma, run.id, "QUEUED");
            await expectCarried(engine, prisma, run.id, "QUEUED", result.row);
            await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);
            const message = await engine.runQueue.readMessage(env.organizationId, run.id);
            expect(message).toMatchObject({ workerQueue: RESTORE_QUEUE });
            const restore = await dequeueFrom(engine, env, RESTORE_QUEUE);
            expect(restore.checkpoint).toMatchObject({
              id: result.row.id,
              friendlyId: result.row.friendlyId,
              type: "KUBERNETES",
              location: "flagged-loc-1",
              imageRef: "flagged-image-ref",
              reason: "TEST_FLAGGED",
              digest: FLAGGED.digest,
            });
            await expectCarried(engine, prisma, run.id, "PENDING_EXECUTING", result.row);
            const continued = await engine.continueRunExecution({
              runId: run.id,
              snapshotId: restore.snapshot.id,
            });
            expect(continued.snapshot.executionStatus).toBe("EXECUTING");
            await engine.completeRunAttempt({
              runId: run.id,
              snapshotId: continued.snapshot.id,
              completion: { id: run.id, ok: true, output: "{}", outputType: "application/json" },
            });
            expect(await runStatus(prisma, run.id)).toBe("COMPLETED_SUCCESSFULLY");

            await counter.settle();
            expect(counter.count() - before).toBe(0);
            expect(flag.calls).toEqual([env.organizationId]);
          } finally {
            await engine.quit();
            await snapshotStore.quit();
            await counter.client.$disconnect();
          }
        }
      );

      for (const scenario of [
        {
          type: "KUBERNETES" as const,
          location: "flagged-loc-2",
          lane: RESTORE_QUEUE,
          others: [WRONG_QUEUE],
        },
        {
          type: "DOCKER" as const,
          location: "flagged-loc-3",
          lane: RESTORE_QUEUE,
          others: [WRONG_QUEUE],
        },
        {
          type: "COMPUTE" as const,
          location: "node-a/snap-1",
          lane: WRONG_QUEUE,
          others: [RESTORE_QUEUE],
        },
      ]) {
        // Catches: the requeue of a QUEUED_EXECUTING run losing the record or the restore lane.
        containerTest(
          `a flagged suspend of a QUEUED_EXECUTING ${scenario.type} run queues it on its restore lane with a state-held checkpoint`,
          async ({ prisma, redisOptions }) => {
            const flag = checkpointFlag(true);
            const { env, snapshotStore, engine } = await flagged(prisma, redisOptions, flag);
            try {
              const { run, wait } = await queuedExecutingOn(
                engine,
                env,
                prisma,
                snapshotStore,
                BIRTH_QUEUE
              );
              expect(await engine.runQueue.currentConcurrencyOfEnvironment(env)).toBe(1);

              const result = accepted(
                await engine.createCheckpoint({
                  runId: run.id,
                  snapshotId: wait.id,
                  checkpoint: {
                    type: scenario.type,
                    location: scenario.location,
                    imageRef: FLAGGED.imageRef,
                    reason: FLAGGED.reason,
                  },
                })
              );
              expect(result.snapshot.executionStatus).toBe("QUEUED");
              expect(flag.calls).toEqual([env.organizationId]);
              await expectCarried(engine, prisma, run.id, "QUEUED", result.row);
              expect(await engine.runQueue.currentConcurrencyOfEnvironment(env)).toBe(0);

              const message = await engine.runQueue.readMessage(env.organizationId, run.id);
              expect(message).toMatchObject({ workerQueue: scenario.lane });
              await engine.runQueue.processMasterQueueForEnvironment(env.id, 10);
              for (const workerQueue of [BIRTH_QUEUE, ...scenario.others]) {
                expect(
                  await engine.dequeueFromWorkerQueue({
                    consumerId: "flagged_consumer",
                    workerQueue,
                    blockingPop: false,
                  })
                ).toEqual([]);
              }
              const restore = await dequeueFrom(engine, env, scenario.lane);
              expect(restore.checkpoint).toMatchObject({
                id: result.row.id,
                type: scenario.type,
              });
              expect(
                await prisma.taskRunCheckpoint.count({ where: { runtimeEnvironmentId: env.id } })
              ).toBe(0);
            } finally {
              await engine.quit();
              await snapshotStore.quit();
            }
          }
        );
      }

      for (const scenario of [
        {
          name: "an unflagged suspend of a MemoryDB-only",
          on: false,
          dial: undefined,
          residency: "redis-primary",
        },
        { name: "a flagged suspend of an off", on: true, dial: "off" as const, residency: null },
        {
          name: "a flagged suspend of a dual-write",
          on: true,
          dial: "dual-write" as const,
          residency: "mirrored",
        },
        {
          name: "a flagged suspend of a redis-read",
          on: true,
          dial: "redis-read" as const,
          residency: "mirrored",
        },
      ]) {
        // Catches: the requeue of a QUEUED_EXECUTING run whose checkpoint is in Postgres carrying the
        // record (a QUEUED snapshot that points at a state-held checkpoint that does not exist).
        containerTest(
          `${scenario.name} QUEUED_EXECUTING run queues it with a Postgres checkpoint and no record`,
          async ({ prisma, redisOptions }) => {
            const flag = checkpointFlag(scenario.on);
            const { env, snapshotStore, engine } = await flagged(prisma, redisOptions, flag, {
              dial: scenario.dial ? () => scenario.dial : undefined,
            });
            try {
              const { run, wait } = await queuedExecutingOn(
                engine,
                env,
                prisma,
                snapshotStore,
                BIRTH_QUEUE,
                scenario.residency
              );
              const result = accepted(
                await engine.createCheckpoint({
                  runId: run.id,
                  snapshotId: wait.id,
                  checkpoint: FLAGGED,
                })
              );
              expect(result.snapshot.executionStatus).toBe("QUEUED");
              expect(flag.calls).toEqual(scenario.dial === undefined ? [env.organizationId] : []);
              expect(await prisma.taskRunCheckpoint.count({ where: { id: result.row.id } })).toBe(
                1
              );
              const head = await snapshotStore.getLatest(run.id);
              if (scenario.dial === "off") {
                expect(head).toBeNull();
              } else {
                expect(head?.entry.executionStatus).toBe("QUEUED");
                expect(head?.entry.checkpointId).toBe(result.row.id);
                expect("checkpointStore" in head!.entry).toBe(false);
              }
              const read = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
              expect(read.executionStatus).toBe("QUEUED");
              expect(read.checkpoint?.id).toBe(result.row.id);
              expect("checkpointStore" in read).toBe(false);
              expect(await stateFields(redisOptions, run.id)).toEqual([]);
              expect(snapshotStore.writes).toBe(0);
            } finally {
              await engine.quit();
              await snapshotStore.quit();
            }
          }
        );
      }

      // Catches: an unflagged suspend of a MemoryDB-only run changing where its checkpoint goes.
      containerTest(
        "an unflagged suspend of a MemoryDB-only run makes one lookup and writes its checkpoint to Postgres as today",
        async ({ prisma, redisOptions }) => {
          const flag = checkpointFlag(false);
          const { env, snapshotStore, engine } = await flagged(prisma, redisOptions, flag);
          try {
            const { run, tokenId, wait } = await startAndBlockOn(
              engine,
              env,
              prisma,
              snapshotStore,
              BIRTH_QUEUE
            );
            const result = accepted(
              await engine.createCheckpoint({
                runId: run.id,
                snapshotId: wait.id,
                checkpoint: FLAGGED,
              })
            );
            expect(result.snapshot.executionStatus).toBe("SUSPENDED");
            expect(flag.calls).toEqual([env.organizationId]);
            expect(await prisma.taskRunCheckpoint.count({ where: { id: result.row.id } })).toBe(1);
            const head = await rawHead(snapshotStore, run.id);
            expect(head.checkpointId).toBe(result.row.id);
            expect("checkpointStore" in head).toBe(false);
            const read = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
            expect("checkpointStore" in read).toBe(false);
            expect(await stateFields(redisOptions, run.id)).toEqual([]);
            expect(snapshotStore.writes).toBe(0);
            expect(await runStatus(prisma, run.id)).toBe("WAITING_TO_RESUME");

            await engine.completeWaitpoint({ id: tokenId });
            const restore = await dequeueFrom(engine, env, RESTORE_QUEUE);
            expect(restore.checkpoint?.id).toBe(result.row.id);
          } finally {
            await engine.quit();
            await snapshotStore.quit();
          }
        }
      );

      for (const dial of ["off", "dual-write", "redis-read"] as const) {
        // Catches: a lookup or a state-held write for a run whose snapshots are in Postgres.
        containerTest(
          `a flagged suspend of a ${dial} run makes no lookup and writes its checkpoint to Postgres`,
          async ({ prisma, redisOptions }) => {
            const flag = checkpointFlag(true);
            const { env, snapshotStore, engine } = await flagged(prisma, redisOptions, flag, {
              dial: () => dial,
            });
            try {
              const run = await triggerRun(engine, env, prisma, {
                friendlyId: generateFriendlyId("run"),
                taskIdentifier: "test-task",
              });
              await dequeueAndStart(engine, `consumer_${run.id}`);
              const { wait } = await block(engine, env, run.id);
              const result = accepted(
                await engine.createCheckpoint({
                  runId: run.id,
                  snapshotId: wait.id,
                  checkpoint: checkpointInput("pg-loc-1"),
                })
              );
              expect(result.snapshot.executionStatus).toBe("SUSPENDED");
              expect(flag.calls).toEqual([]);
              expect(await prisma.taskRunCheckpoint.count({ where: { id: result.row.id } })).toBe(
                1
              );
              const read = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
              expect(read.checkpoint?.id).toBe(result.row.id);
              expect("checkpointStore" in read).toBe(false);
              expect(await stateFields(redisOptions, run.id)).toEqual([]);
              expect(snapshotStore.writes).toBe(0);
            } finally {
              await engine.quit();
              await snapshotStore.quit();
            }
          }
        );
      }

      // Catches: a lookup or a write made before a suspend is discarded, or for a missing run.
      containerTest(
        "discarded suspends and a suspend of a missing run make no lookup and write nothing",
        async ({ prisma, redisOptions }) => {
          const flag = checkpointFlag(true);
          const { env, snapshotStore, engine } = await flagged(prisma, redisOptions, flag);
          try {
            const { run, wait } = await startAndBlock(engine, env, prisma, snapshotStore);
            const observe = async () => ({
              calls: flag.calls.length,
              rows: await prisma.taskRunCheckpoint.count({
                where: { runtimeEnvironmentId: env.id },
              }),
              fields: await stateFields(redisOptions, run.id),
              latest: await latestId(engine, prisma, run.id),
            });

            let before = await observe();
            expect(
              await engine.createCheckpoint({
                runId: run.id,
                snapshotId: wait.id,
                checkpoint: { type: "COMPUTE", location: "foo://bar-123" },
              })
            ).toEqual({ ok: false, error: "Invalid checkpoint location" });
            expect(await observe()).toEqual(before);

            assertNonNullable(wait.previousSnapshotId);
            expect(
              await engine.createCheckpoint({
                runId: run.id,
                snapshotId: wait.previousSnapshotId,
                checkpoint: FLAGGED,
              })
            ).toEqual({ ok: false, error: "Not the latest snapshot" });
            expect(await observe()).toEqual(before);

            const result = accepted(
              await engine.createCheckpoint({
                runId: run.id,
                snapshotId: wait.id,
                checkpoint: FLAGGED,
              })
            );
            expect(flag.calls).toEqual([env.organizationId]);
            expect(await stateFields(redisOptions, run.id)).toEqual([`${result.row.id}#cp`]);

            before = await observe();
            expect(
              await engine.createCheckpoint({
                runId: run.id,
                snapshotId: result.snapshot.id,
                checkpoint: FLAGGED,
              })
            ).toEqual({ ok: false, error: "Status SUSPENDED is not checkpointable" });
            expect(await observe()).toEqual(before);

            await expect(
              engine.createCheckpoint({
                runId: generateFriendlyId("run").replace(/^run_/, ""),
                snapshotId: wait.id,
                checkpoint: FLAGGED,
              })
            ).rejects.toThrow();
            expect(await observe()).toEqual(before);
          } finally {
            await engine.quit();
            await snapshotStore.quit();
          }
        }
      );

      // Catches: a failed lookup swallowed as off (a Postgres checkpoint), or work done before it.
      containerTest(
        "a failed checkpoint flag lookup rejects the suspend of a waiting and of a QUEUED_EXECUTING run and changes nothing",
        async ({ prisma, redisOptions }) => {
          const failure = new Error("checkpoint flag lookup failed");
          const flag = checkpointFlag(failure);
          const { env, snapshotStore, engine } = await flagged(prisma, redisOptions, flag);
          const statusChanged: string[] = [];
          engine.eventBus.on("runStatusChanged", (event) => statusChanged.push(event.run.id));
          try {
            const waiting = await startAndBlockOn(engine, env, prisma, snapshotStore, BIRTH_QUEUE);
            const queued = await queuedExecutingOn(engine, env, prisma, snapshotStore, BIRTH_QUEUE);
            for (const [index, subject] of [waiting, queued].entries()) {
              const runId = subject.run.id;
              const observe = async () => {
                const row = await prisma.taskRun.findFirstOrThrow({ where: { id: runId } });
                return {
                  latest: await latestId(engine, prisma, runId),
                  status: row.status,
                  updatedAt: row.updatedAt,
                  message: await engine.runQueue.readMessage(env.organizationId, runId),
                  concurrency: await engine.runQueue.currentConcurrencyOfEnvironment(env),
                  rows: await prisma.taskRunCheckpoint.count({
                    where: { runtimeEnvironmentId: env.id },
                  }),
                  fields: await stateFields(redisOptions, runId),
                  events: statusChanged.filter((id) => id === runId).length,
                };
              };
              const before = await observe();
              await expect(
                engine.createCheckpoint({
                  runId,
                  snapshotId: subject.wait.id,
                  checkpoint: FLAGGED,
                })
              ).rejects.toBe(failure);
              expect(flag.calls).toEqual(Array(index + 1).fill(env.organizationId));
              expect(await observe()).toEqual(before);
            }
            expect(snapshotStore.writes).toBe(0);
          } finally {
            await engine.quit();
            await snapshotStore.quit();
          }
        }
      );

      // Catches: a failed state write falling back to Postgres, or a snapshot written that refers to
      // a checkpoint that was never stored.
      containerTest(
        "a failed state write rejects the suspend with no Postgres fallback and no snapshot that refers to it",
        async ({ prisma, redisOptions }) => {
          const flag = checkpointFlag(true);
          const { env, snapshotStore, engine } = await flagged(prisma, redisOptions, flag);
          try {
            for (const fail of ["throw", "false"] as const) {
              const waiting = await startAndBlockOn(
                engine,
                env,
                prisma,
                snapshotStore,
                BIRTH_QUEUE
              );
              const queued = await queuedExecutingOn(
                engine,
                env,
                prisma,
                snapshotStore,
                BIRTH_QUEUE
              );
              for (const [subject, expectedLatest] of [
                [waiting, waiting.wait.id],
                [queued, queued.queuedExecuting.id],
              ] as const) {
                const runId = subject.run.id;
                const writes = snapshotStore.writes;
                const message = await engine.runQueue.readMessage(env.organizationId, runId);
                expect(await latestId(engine, prisma, runId)).toBe(expectedLatest);
                snapshotStore.fail = fail;
                const error = await engine
                  .createCheckpoint({ runId, snapshotId: subject.wait.id, checkpoint: FLAGGED })
                  .then(
                    () => undefined,
                    (e: unknown) => e
                  );
                snapshotStore.fail = undefined;
                expect(error).toBeInstanceOf(SnapshotWriteUnavailableError);
                expect(snapshotStore.writes).toBe(writes + 1);
                expect(
                  await prisma.taskRunCheckpoint.count({ where: { runtimeEnvironmentId: env.id } })
                ).toBe(0);
                expect(await stateFields(redisOptions, runId)).toEqual([]);
                expect(await latestId(engine, prisma, runId)).toBe(expectedLatest);
                expect(await runStatus(prisma, runId)).toBe("WAITING_TO_RESUME");
                expect(await engine.runQueue.readMessage(env.organizationId, runId)).toEqual(
                  message
                );
              }
            }
          } finally {
            await engine.quit();
            await snapshotStore.quit();
          }
        }
      );

      // Catches: a flag turned off still writing into the state, or a cached lookup.
      containerTest(
        "after the flag goes off, the next suspend writes a Postgres checkpoint and the run restores from it",
        async ({ prisma, redisOptions }) => {
          const flag = checkpointFlag(true);
          const { env, snapshotStore, engine } = await flagged(prisma, redisOptions, flag);
          try {
            const first = await startAndBlock(engine, env, prisma, snapshotStore);
            const one = await suspend(engine, first.run.id, first.wait.id, "loc-1");
            await expectCarried(
              engine,
              prisma,
              first.run.id,
              "SUSPENDED",
              one.checkpoint as unknown as Seeded
            );
            expect(snapshotStore.writes).toBe(1);

            flag.set(false);
            const second = await startAndBlock(engine, env, prisma, snapshotStore);
            const two = await suspend(engine, second.run.id, second.wait.id, "pg-loc-1");
            expect(flag.calls).toEqual([env.organizationId, env.organizationId]);
            expect(await prisma.taskRunCheckpoint.count({ where: { id: two.checkpoint.id } })).toBe(
              1
            );
            const read = await getLatestExecutionSnapshot(prisma, second.run.id, engine.runStore);
            expect("checkpointStore" in read).toBe(false);
            expect(await stateFields(redisOptions, second.run.id)).toEqual([]);
            expect(snapshotStore.writes).toBe(1);

            await engine.completeWaitpoint({ id: second.tokenId });
            const restore = await dequeueRestore(engine, env);
            expect(restore.run.id).toBe(second.run.id);
            expect(restore.checkpoint?.id).toBe(two.checkpoint.id);
          } finally {
            await engine.quit();
            await snapshotStore.quit();
          }
        }
      );

      // Catches: one organisation's flag deciding another organisation's checkpoint store.
      containerTest(
        "with one organisation flagged, another organisation's suspend writes a Postgres checkpoint",
        async ({ prisma, redisOptions }) => {
          const calls: string[] = [];
          let flaggedOrganizationId = "";
          const resolver = {
            resolve: async (organizationId: string) => {
              calls.push(organizationId);
              return organizationId === flaggedOrganizationId;
            },
          };
          const {
            env: envA,
            snapshotStore,
            engine,
          } = await flagged(prisma, redisOptions, resolver);
          flaggedOrganizationId = envA.organizationId;
          try {
            const envB = await secondOrganisationEnvironment(prisma, envA);
            await setupBackgroundWorker(engine, envB, "test-task");

            const a = await startAndBlock(engine, envA, prisma, snapshotStore);
            const checkpointA = (await suspend(engine, a.run.id, a.wait.id, "loc-a")).checkpoint;
            const b = await startAndBlock(engine, envB, prisma, snapshotStore);
            const checkpointB = (await suspend(engine, b.run.id, b.wait.id, "pg-loc-1")).checkpoint;

            expect(calls).toEqual([envA.organizationId, envB.organizationId]);
            await expectCarried(
              engine,
              prisma,
              a.run.id,
              "SUSPENDED",
              checkpointA as unknown as Seeded
            );
            expect(await prisma.taskRunCheckpoint.count({ where: { id: checkpointB.id } })).toBe(1);
            const readB = await getLatestExecutionSnapshot(prisma, b.run.id, engine.runStore);
            expect(readB.checkpoint?.id).toBe(checkpointB.id);
            expect("checkpointStore" in readB).toBe(false);
            expect(await stateFields(redisOptions, b.run.id)).toEqual([]);
            expect(snapshotStore.writes).toBe(1);
          } finally {
            await engine.quit();
            await snapshotStore.quit();
          }
        }
      );

      // Catches: the checkpoint flag read through the waitpoint flag or the snapshot store setting,
      // or a checkpoint flag that changes a run's residency or a waitpoint's store.
      containerTest(
        "the checkpoint flag is independent of the waitpoint flag and the snapshot store setting",
        async ({ prisma, redisOptions }) => {
          const flag = checkpointFlag(false);
          const waitpointStore = new WaitpointStoreCoordinator({ redisOptions });
          const { env, snapshotStore, engine } = await flagged(prisma, redisOptions, flag, {
            waitpointStore,
          });
          try {
            // (a) The waitpoint flag on, the checkpoint flag off.
            const first = await startAndBlock(engine, env, prisma, snapshotStore);
            const firstAnchor = cycleAnchorSnapshotId(
              await getLatestExecutionSnapshot(prisma, first.run.id, engine.runStore)
            );
            const one = await suspend(engine, first.run.id, first.wait.id, "pg-loc-1");
            expect(await prisma.taskRunCheckpoint.count({ where: { id: one.checkpoint.id } })).toBe(
              1
            );
            expect(await stateFields(redisOptions, first.run.id)).toEqual([]);
            const oneSuspended = await getLatestExecutionSnapshot(
              prisma,
              first.run.id,
              engine.runStore
            );
            expect(oneSuspended.executionStatus).toBe("SUSPENDED");
            expect(
              (oneSuspended.metadata as { waitpointCycleAnchor?: string } | null)
                ?.waitpointCycleAnchor
            ).toBe(firstAnchor);

            // (b) Both flags on: residency and the waitpoint's store are unchanged by the suspend.
            flag.set(true);
            const second = await startAndBlock(engine, env, prisma, snapshotStore);
            const residency = await snapshotStore.readBirthResidency(second.run.id);
            const tokenRows = await prisma.waitpoint.count({ where: { id: second.tokenId } });
            const secondAnchor = cycleAnchorSnapshotId(
              await getLatestExecutionSnapshot(prisma, second.run.id, engine.runStore)
            );
            const two = await suspend(engine, second.run.id, second.wait.id, "loc-2");
            expect(await snapshotStore.readBirthResidency(second.run.id)).toBe(residency);
            expect(await prisma.waitpoint.count({ where: { id: second.tokenId } })).toBe(tokenRows);
            const twoSuspended = await expectCarried(
              engine,
              prisma,
              second.run.id,
              "SUSPENDED",
              two.checkpoint as unknown as Seeded
            );
            expect(
              (twoSuspended.metadata as { waitpointCycleAnchor?: string } | null)
                ?.waitpointCycleAnchor
            ).toBe(secondAnchor);
          } finally {
            await engine.quit();
            await snapshotStore.quit();
            await waitpointStore.quit();
          }

          // (c) The setting lowered after a run's birth: that run is still MemoryDB-only.
          let dial: SnapshotStoreDial = "redis-only";
          const lowered = checkpointFlag(true);
          const separate = await flagged(prisma, redisOptions, lowered, {
            dial: () => dial,
            env,
          });
          try {
            const third = await startAndBlock(separate.engine, env, prisma, separate.snapshotStore);
            dial = "off";
            const three = await suspend(separate.engine, third.run.id, third.wait.id, "loc-3");
            expect(lowered.calls).toEqual([env.organizationId]);
            await expectCarried(
              separate.engine,
              prisma,
              third.run.id,
              "SUSPENDED",
              three.checkpoint as unknown as Seeded
            );

            const fourth = await triggerRun(separate.engine, env, prisma, {
              friendlyId: generateFriendlyId("run"),
              taskIdentifier: "test-task",
            });
            await dequeueAndStart(separate.engine, `consumer_${fourth.id}`);
            const { wait } = await block(separate.engine, env, fourth.id);
            const four = await suspend(separate.engine, fourth.id, wait.id, "pg-loc-1");
            expect(lowered.calls).toEqual([env.organizationId]);
            expect(
              await prisma.taskRunCheckpoint.count({ where: { id: four.checkpoint.id } })
            ).toBe(1);
          } finally {
            await separate.engine.quit();
            await separate.snapshotStore.quit();
          }
        }
      );
    });
  });
});
