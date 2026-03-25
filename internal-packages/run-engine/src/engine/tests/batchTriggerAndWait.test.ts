import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect, describe } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "node:timers/promises";
import { generateFriendlyId, BatchId } from "@trigger.dev/core/v3/isomorphic";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import type { CompleteBatchResult, BatchItem } from "../../batch-queue/types.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine batchTriggerAndWait", () => {
  containerTest("batchTriggerAndWait (no idempotency)", async ({ prisma, redisOptions }) => {
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

      //dequeue parent
      await setTimeout(500);
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
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

      //dequeue and start the 1st child
      await setTimeout(500);
      const dequeuedChild = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
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
      expect(parentExecutionDataAfterFirstChildComplete.snapshot.executionStatus).toBe(
        "EXECUTING_WITH_WAITPOINTS"
      );
      expect(parentExecutionDataAfterFirstChildComplete.batch?.id).toBe(batch.id);
      expect(parentExecutionDataAfterFirstChildComplete.completedWaitpoints.length).toBe(0);

      //dequeue and start the 2nd child
      await setTimeout(500);
      const dequeuedChild2 = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
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

      await setTimeout(1_000);

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
      expect(parentExecutionDataAfterSecondChildComplete.snapshot.executionStatus).toBe(
        "EXECUTING"
      );
      expect(parentExecutionDataAfterSecondChildComplete.batch?.id).toBe(batch.id);
      expect(parentExecutionDataAfterSecondChildComplete.completedWaitpoints.length).toBe(3);

      const completedWaitpoint0 =
        parentExecutionDataAfterSecondChildComplete.completedWaitpoints.find((w) => w.index === 0);
      assertNonNullable(completedWaitpoint0);
      expect(completedWaitpoint0.id).toBe(child1Waitpoint!.waitpointId);
      expect(completedWaitpoint0.completedByTaskRun?.id).toBe(child1.id);
      expect(completedWaitpoint0.completedByTaskRun?.batch?.id).toBe(batch.id);
      expect(completedWaitpoint0.output).toBe('{"foo":"bar"}');
      expect(completedWaitpoint0.index).toBe(0);

      const completedWaitpoint1 =
        parentExecutionDataAfterSecondChildComplete.completedWaitpoints.find((w) => w.index === 1);
      assertNonNullable(completedWaitpoint1);
      expect(completedWaitpoint1.id).toBe(child2Waitpoint!.waitpointId);
      expect(completedWaitpoint1.completedByTaskRun?.id).toBe(child2.id);
      expect(completedWaitpoint1.completedByTaskRun?.batch?.id).toBe(batch.id);
      expect(completedWaitpoint1.index).toBe(1);
      expect(completedWaitpoint1.output).toBe('{"baz":"qux"}');

      const batchWaitpointAfter =
        parentExecutionDataAfterSecondChildComplete.completedWaitpoints.find(
          (w) => w.type === "BATCH"
        );
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

  containerTest(
    "batch ID should not carry over to triggerAndWait",
    async ({ prisma, redisOptions }) => {
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
        const batchChildTask = "batch-child-task";
        const triggerAndWaitChildTask = "trigger-and-wait-child-task";

        //create background worker
        await setupBackgroundWorker(engine, authenticatedEnvironment, [
          parentTask,
          batchChildTask,
          triggerAndWaitChildTask,
        ]);

        //create a batch
        const batch = await prisma.batchTaskRun.create({
          data: {
            friendlyId: generateFriendlyId("batch"),
            runtimeEnvironmentId: authenticatedEnvironment.id,
          },
        });

        //trigger the parent run
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

        //dequeue parent
        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
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
        expect(afterBlockedByBatch.batch?.id).toBe(batch.id);

        //create a batch child
        const batchChild = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_c1234",
            environment: authenticatedEnvironment,
            taskIdentifier: batchChildTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: `task/${batchChildTask}`,
            isTest: false,
            tags: [],
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun.id,
            batch: { id: batch.id, index: 0 },
          },
          prisma
        );

        const parentAfterBatchChild = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentAfterBatchChild);
        expect(parentAfterBatchChild.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
        expect(parentAfterBatchChild.batch?.id).toBe(batch.id);

        //dequeue and start the batch child
        await setTimeout(500);
        const dequeuedBatchChild = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });

        expect(dequeuedBatchChild.length).toBe(1);

        const batchChildAttempt = await engine.startRunAttempt({
          runId: batchChild.id,
          snapshotId: dequeuedBatchChild[0].snapshot.id,
        });

        //complete the batch child
        await engine.completeRunAttempt({
          runId: batchChildAttempt.run.id,
          snapshotId: batchChildAttempt.snapshot.id,
          completion: {
            id: batchChild.id,
            ok: true,
            output: '{"foo":"bar"}',
            outputType: "application/json",
          },
        });

        await setTimeout(500);

        const runWaitpointsAfterBatchChild = await prisma.taskRunWaitpoint.findMany({
          where: {
            taskRunId: parentRun.id,
          },
          include: {
            waitpoint: true,
          },
        });
        expect(runWaitpointsAfterBatchChild.length).toBe(0);

        //parent snapshot
        const parentExecutionDataAfterBatchChildComplete = await engine.getRunExecutionData({
          runId: parentRun.id,
        });
        assertNonNullable(parentExecutionDataAfterBatchChildComplete);
        expect(parentExecutionDataAfterBatchChildComplete.snapshot.executionStatus).toBe(
          "EXECUTING"
        );
        expect(parentExecutionDataAfterBatchChildComplete.batch?.id).toBe(batch.id);
        expect(parentExecutionDataAfterBatchChildComplete.completedWaitpoints.length).toBe(2);

        //now triggerAndWait
        const triggerAndWaitChildRun = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_c123456",
            environment: authenticatedEnvironment,
            taskIdentifier: triggerAndWaitChildTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t123456",
            spanId: "s123456",
            workerQueue: "main",
            queue: `task/${triggerAndWaitChildTask}`,
            isTest: false,
            tags: [],
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun.id,
          },
          prisma
        );

        //check that the parent's execution data doesn't have a batch ID
        const parentAfterTriggerAndWait = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentAfterTriggerAndWait);
        expect(parentAfterTriggerAndWait.snapshot.executionStatus).toBe(
          "EXECUTING_WITH_WAITPOINTS"
        );
        expect(parentAfterTriggerAndWait.batch).toBeUndefined();
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "batchTriggerAndWait v2 - all runs created and completed successfully",
    async ({ prisma, redisOptions }) => {
      // Create environment
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
        batchQueue: {
          redis: redisOptions,
          drr: {
            quantum: 5,
            maxDeficit: 50,
          },
          consumerCount: 1,
          consumerIntervalMs: 50,
        },
      });

      // Track created runs
      const createdRuns: Array<{ index: number; runId: string }> = [];
      let completionResult: CompleteBatchResult | null = null;

      // Set up batch processing callback - creates runs via engine.trigger
      engine.setBatchProcessItemCallback(async ({ batchId, itemIndex, item, meta }) => {
        try {
          const friendlyId = generateFriendlyId("run");
          const run = await engine.trigger(
            {
              number: itemIndex + 1,
              friendlyId,
              environment: authenticatedEnvironment,
              taskIdentifier: item.task,
              payload:
                typeof item.payload === "string" ? item.payload : JSON.stringify(item.payload),
              payloadType: item.payloadType ?? "application/json",
              context: {},
              traceContext: {},
              traceId: `t${batchId}${itemIndex}`,
              spanId: `s${batchId}${itemIndex}`,
              workerQueue: "main",
              queue: `task/${item.task}`,
              isTest: false,
              tags: [],
              resumeParentOnCompletion: meta.resumeParentOnCompletion,
              parentTaskRunId: meta.parentRunId,
              batch: { id: batchId, index: itemIndex },
            },
            prisma
          );

          createdRuns.push({ index: itemIndex, runId: run.id });
          return { success: true as const, runId: friendlyId };
        } catch (error) {
          return {
            success: false as const,
            error: error instanceof Error ? error.message : String(error),
            errorCode: "TRIGGER_ERROR",
          };
        }
      });

      // Set up completion callback
      engine.setBatchCompletionCallback(async (result) => {
        completionResult = result;

        // Update batch in database
        await prisma.batchTaskRun.update({
          where: { id: result.batchId },
          data: {
            status: result.failedRunCount > 0 ? "PARTIAL_FAILED" : "PENDING",
            runIds: result.runIds,
            successfulRunCount: result.successfulRunCount,
            failedRunCount: result.failedRunCount,
          },
        });

        // Try to complete the batch (this will check if all runs are done)
        await engine.tryCompleteBatch({ batchId: result.batchId });
      });

      try {
        const parentTask = "parent-task";
        const childTask = "child-task";

        // Create background worker
        await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

        // Create a batch record with v2 version
        const { id: batchId, friendlyId: batchFriendlyId } = BatchId.generate();
        const batch = await prisma.batchTaskRun.create({
          data: {
            id: batchId,
            friendlyId: batchFriendlyId,
            runtimeEnvironmentId: authenticatedEnvironment.id,
            status: "PROCESSING",
            runCount: 2,
            batchVersion: "runengine:v2",
          },
        });

        // Trigger the parent run
        const parentRun = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_parent",
            environment: authenticatedEnvironment,
            taskIdentifier: parentTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_parent",
            spanId: "s_parent",
            workerQueue: "main",
            queue: `task/${parentTask}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        // Dequeue parent
        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(1);

        // Start parent attempt
        const initialExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(initialExecutionData);
        await engine.startRunAttempt({
          runId: parentRun.id,
          snapshotId: initialExecutionData.snapshot.id,
        });

        // Block parent using the batch
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

        // Initialize batch metadata in Redis (Phase 1)
        await engine.initializeBatch({
          batchId: batch.id,
          friendlyId: batch.friendlyId,
          environmentId: authenticatedEnvironment.id,
          environmentType: authenticatedEnvironment.type,
          organizationId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          runCount: 2,
          parentRunId: parentRun.id,
          resumeParentOnCompletion: true,
        });

        // Enqueue batch items (Phase 2)
        const batchItems: BatchItem[] = [
          { task: childTask, payload: '{"item": 0}', payloadType: "application/json" },
          { task: childTask, payload: '{"item": 1}', payloadType: "application/json" },
        ];

        for (let i = 0; i < batchItems.length; i++) {
          await engine.enqueueBatchItem(batch.id, authenticatedEnvironment.id, i, batchItems[i]);
        }

        // Wait for BatchQueue consumers to process items AND database to be updated
        await vi.waitFor(
          async () => {
            expect(createdRuns.length).toBe(2);
            expect(completionResult).not.toBeNull();
            // Also wait for the database update to complete
            const batchRecord = await prisma.batchTaskRun.findUnique({
              where: { id: batch.id },
            });
            expect(batchRecord?.successfulRunCount).toBe(2);
          },
          { timeout: 10000 }
        );

        // Verify completion result (type assertion needed due to async closure)
        const finalResult = completionResult!;
        expect(finalResult.batchId).toBe(batch.id);
        expect(finalResult.successfulRunCount).toBe(2);
        expect(finalResult.failedRunCount).toBe(0);
        expect(finalResult.failures).toHaveLength(0);

        // Verify batch record updated
        const batchAfterProcessing = await prisma.batchTaskRun.findUnique({
          where: { id: batch.id },
        });
        expect(batchAfterProcessing?.successfulRunCount).toBe(2);
        expect(batchAfterProcessing?.failedRunCount).toBe(0);

        // Parent should still be waiting for runs to complete
        const parentAfterProcessing = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentAfterProcessing);
        expect(parentAfterProcessing.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        // Now complete the child runs
        for (const { runId } of createdRuns) {
          // Dequeue and start child
          await setTimeout(300);
          const dequeuedChild = await engine.dequeueFromWorkerQueue({
            consumerId: "test_12345",
            workerQueue: "main",
          });

          if (dequeuedChild.length === 0) continue;

          const childAttempt = await engine.startRunAttempt({
            runId: dequeuedChild[0].run.id,
            snapshotId: dequeuedChild[0].snapshot.id,
          });

          // Complete the child
          await engine.completeRunAttempt({
            runId: childAttempt.run.id,
            snapshotId: childAttempt.snapshot.id,
            completion: {
              id: runId,
              ok: true,
              output: '{"result":"success"}',
              outputType: "application/json",
            },
          });
        }

        // Wait for parent to be unblocked (use waitFor since tryCompleteBatch runs as background job)
        await vi.waitFor(
          async () => {
            const waitpoints = await prisma.taskRunWaitpoint.findMany({
              where: { taskRunId: parentRun.id },
            });
            expect(waitpoints.length).toBe(0);
          },
          { timeout: 10000 }
        );

        // Parent should now be executing
        const parentAfterCompletion = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentAfterCompletion);
        expect(parentAfterCompletion.snapshot.executionStatus).toBe("EXECUTING");
        expect(parentAfterCompletion.completedWaitpoints.length).toBe(3); // 2 run waitpoints + 1 batch waitpoint

        // Wait for batch to be marked COMPLETED (runs in background)
        await vi.waitFor(
          async () => {
            const batchRecord = await prisma.batchTaskRun.findUnique({
              where: { id: batch.id },
            });
            expect(batchRecord?.status).toBe("COMPLETED");
          },
          { timeout: 10000 }
        );
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "batchTriggerAndWait v2 - some runs fail to be created, remaining runs complete successfully",
    async ({ prisma, redisOptions }) => {
      // Create environment
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
        batchQueue: {
          redis: redisOptions,
          drr: {
            quantum: 5,
            maxDeficit: 50,
          },
          consumerCount: 1,
          consumerIntervalMs: 50,
        },
      });

      // Track created runs and failures
      const createdRuns: Array<{ index: number; runId: string }> = [];
      let completionResult: CompleteBatchResult | null = null;
      const failingIndices = [1]; // Index 1 will fail to be triggered

      // Set up batch processing callback - simulates some items failing
      engine.setBatchProcessItemCallback(async ({ batchId, itemIndex, item, meta }) => {
        // Simulate failure for specific indices
        if (failingIndices.includes(itemIndex)) {
          return {
            success: false as const,
            error: "Simulated trigger failure",
            errorCode: "SIMULATED_FAILURE",
          };
        }

        try {
          const friendlyId = generateFriendlyId("run");
          const run = await engine.trigger(
            {
              number: itemIndex + 1,
              friendlyId,
              environment: authenticatedEnvironment,
              taskIdentifier: item.task,
              payload:
                typeof item.payload === "string" ? item.payload : JSON.stringify(item.payload),
              payloadType: item.payloadType ?? "application/json",
              context: {},
              traceContext: {},
              traceId: `t${batchId}${itemIndex}`,
              spanId: `s${batchId}${itemIndex}`,
              workerQueue: "main",
              queue: `task/${item.task}`,
              isTest: false,
              tags: [],
              resumeParentOnCompletion: meta.resumeParentOnCompletion,
              parentTaskRunId: meta.parentRunId,
              batch: { id: batchId, index: itemIndex },
            },
            prisma
          );

          createdRuns.push({ index: itemIndex, runId: run.id });
          return { success: true as const, runId: friendlyId };
        } catch (error) {
          return {
            success: false as const,
            error: error instanceof Error ? error.message : String(error),
            errorCode: "TRIGGER_ERROR",
          };
        }
      });

      // Set up completion callback
      engine.setBatchCompletionCallback(async (result) => {
        completionResult = result;

        // Determine status: PARTIAL_FAILED if some failed
        const status =
          result.failedRunCount > 0 && result.successfulRunCount === 0
            ? "ABORTED"
            : result.failedRunCount > 0
            ? "PARTIAL_FAILED"
            : "PENDING";

        // Update batch in database
        await prisma.batchTaskRun.update({
          where: { id: result.batchId },
          data: {
            status,
            runIds: result.runIds,
            successfulRunCount: result.successfulRunCount,
            failedRunCount: result.failedRunCount,
          },
        });

        // Create error records for failures
        for (const failure of result.failures) {
          await prisma.batchTaskRunError.create({
            data: {
              batchTaskRunId: result.batchId,
              index: failure.index,
              taskIdentifier: failure.taskIdentifier,
              payload: failure.payload,
              options: failure.options ? JSON.parse(JSON.stringify(failure.options)) : undefined,
              error: failure.error,
              errorCode: failure.errorCode,
            },
          });
        }

        // Try to complete the batch (only if not aborted)
        if (status !== "ABORTED") {
          await engine.tryCompleteBatch({ batchId: result.batchId });
        }
      });

      try {
        const parentTask = "parent-task";
        const childTask = "child-task";

        // Create background worker
        await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

        // Create a batch record with v2 version
        const { id: batchId, friendlyId: batchFriendlyId } = BatchId.generate();
        const batch = await prisma.batchTaskRun.create({
          data: {
            id: batchId,
            friendlyId: batchFriendlyId,
            runtimeEnvironmentId: authenticatedEnvironment.id,
            status: "PROCESSING",
            runCount: 3, // 3 items, 1 will fail
            batchVersion: "runengine:v2",
          },
        });

        // Trigger the parent run
        const parentRun = await engine.trigger(
          {
            number: 1,
            friendlyId: generateFriendlyId("run"),
            environment: authenticatedEnvironment,
            taskIdentifier: parentTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "tparentpartial",
            spanId: "sparentpartial",
            workerQueue: "main",
            queue: `task/${parentTask}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        // Dequeue parent
        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(1);

        // Start parent attempt
        const initialExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(initialExecutionData);
        await engine.startRunAttempt({
          runId: parentRun.id,
          snapshotId: initialExecutionData.snapshot.id,
        });

        // Block parent using the batch
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

        // Initialize batch metadata in Redis (Phase 1)
        await engine.initializeBatch({
          batchId: batch.id,
          friendlyId: batch.friendlyId,
          environmentId: authenticatedEnvironment.id,
          environmentType: authenticatedEnvironment.type,
          organizationId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          runCount: 3,
          parentRunId: parentRun.id,
          resumeParentOnCompletion: true,
        });

        // Enqueue batch items (Phase 2) - index 1 will fail
        const batchItems: BatchItem[] = [
          { task: childTask, payload: '{"item": 0}', payloadType: "application/json" },
          { task: childTask, payload: '{"item": 1}', payloadType: "application/json" }, // Will fail
          { task: childTask, payload: '{"item": 2}', payloadType: "application/json" },
        ];

        for (let i = 0; i < batchItems.length; i++) {
          await engine.enqueueBatchItem(batch.id, authenticatedEnvironment.id, i, batchItems[i]);
        }

        // Wait for BatchQueue consumers to process items AND database to be updated
        await vi.waitFor(
          async () => {
            expect(completionResult).not.toBeNull();
            // Also wait for the database update to complete
            const batchRecord = await prisma.batchTaskRun.findUnique({
              where: { id: batch.id },
            });
            expect(batchRecord?.status).toBe("PARTIAL_FAILED");
          },
          { timeout: 10000 }
        );

        // Verify completion result (type assertion needed due to async closure)
        const finalResult = completionResult!;
        expect(finalResult.batchId).toBe(batch.id);
        expect(finalResult.successfulRunCount).toBe(2); // 2 succeeded
        expect(finalResult.failedRunCount).toBe(1); // 1 failed
        expect(finalResult.failures).toHaveLength(1);
        expect(finalResult.failures[0].index).toBe(1);
        expect(finalResult.failures[0].error).toBe("Simulated trigger failure");
        expect(finalResult.failures[0].errorCode).toBe("SIMULATED_FAILURE");

        // Verify batch record updated with PARTIAL_FAILED status
        const batchAfterProcessing = await prisma.batchTaskRun.findUnique({
          where: { id: batch.id },
          include: { errors: true },
        });
        expect(batchAfterProcessing?.status).toBe("PARTIAL_FAILED");
        expect(batchAfterProcessing?.successfulRunCount).toBe(2);
        expect(batchAfterProcessing?.failedRunCount).toBe(1);
        expect(batchAfterProcessing?.errors).toHaveLength(1);
        expect(batchAfterProcessing?.errors[0].index).toBe(1);
        expect(batchAfterProcessing?.errors[0].error).toBe("Simulated trigger failure");

        // Only 2 runs should have been created (indices 0 and 2)
        expect(createdRuns.length).toBe(2);
        expect(createdRuns.map((r) => r.index).sort()).toEqual([0, 2]);

        // Parent should still be waiting for the created runs to complete
        const parentAfterProcessing = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentAfterProcessing);
        expect(parentAfterProcessing.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        // Now complete the successfully created child runs
        for (const { runId } of createdRuns) {
          // Dequeue and start child
          await setTimeout(300);
          const dequeuedChild = await engine.dequeueFromWorkerQueue({
            consumerId: "test_12345",
            workerQueue: "main",
          });

          if (dequeuedChild.length === 0) continue;

          const childAttempt = await engine.startRunAttempt({
            runId: dequeuedChild[0].run.id,
            snapshotId: dequeuedChild[0].snapshot.id,
          });

          // Complete the child
          await engine.completeRunAttempt({
            runId: childAttempt.run.id,
            snapshotId: childAttempt.snapshot.id,
            completion: {
              id: runId,
              ok: true,
              output: '{"result":"success"}',
              outputType: "application/json",
            },
          });
        }

        // Wait for parent to be unblocked (use waitFor since tryCompleteBatch runs as background job)
        await vi.waitFor(
          async () => {
            const waitpoints = await prisma.taskRunWaitpoint.findMany({
              where: { taskRunId: parentRun.id },
            });
            expect(waitpoints.length).toBe(0);
          },
          { timeout: 10000 }
        );

        // Parent should now be executing (resumed even though some runs failed to trigger)
        const parentAfterCompletion = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentAfterCompletion);
        expect(parentAfterCompletion.snapshot.executionStatus).toBe("EXECUTING");

        // Should have 3 completed waitpoints: 2 run waitpoints + 1 batch waitpoint
        // (even though 1 run failed to trigger, the batch waitpoint is still completed)
        expect(parentAfterCompletion.completedWaitpoints.length).toBe(3);

        // Wait for batch to be marked COMPLETED (runs in background)
        await vi.waitFor(
          async () => {
            const batchRecord = await prisma.batchTaskRun.findUnique({
              where: { id: batch.id },
            });
            expect(batchRecord?.status).toBe("COMPLETED");
          },
          { timeout: 10000 }
        );
      } finally {
        await engine.quit();
      }
    }
  );
});
