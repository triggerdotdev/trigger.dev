import {
  assertNonNullable,
  containerTestWithIsolatedRedis as containerTest,
} from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect, describe, vi } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "node:timers/promises";
import { generateFriendlyId, BatchId } from "@trigger.dev/core/v3/isomorphic";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import type {
  CompleteBatchResult,
  BatchItem,
  InitializeBatchOptions,
} from "../../batch-queue/types.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine 2-Phase Batch API", () => {
  containerTest(
    "2-phase batch: initialize batch, stream items one by one, items get processed",
    async ({ prisma, redisOptions }) => {
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
        batchQueue: {
          redis: redisOptions,
          consumerCount: 2,
          consumerIntervalMs: 50,
          drr: {
            quantum: 10,
            maxDeficit: 100,
          },
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const createdRuns: Array<{ runId: string; itemIndex: number }> = [];
      let completionResult: CompleteBatchResult | null = null;

      // Set up callbacks
      engine.setBatchProcessItemCallback(async ({ batchId, itemIndex, item, meta }) => {
        // Simulate creating a run
        const friendlyId = generateFriendlyId("run");
        const run = await engine.trigger(
          {
            friendlyId,
            environment: authenticatedEnvironment,
            taskIdentifier: item.task,
            payload: typeof item.payload === "string" ? item.payload : JSON.stringify(item.payload),
            payloadType: item.payloadType ?? "application/json",
            context: {},
            traceContext: {},
            traceId: `t_${batchId}_${itemIndex}`,
            spanId: `s_${batchId}_${itemIndex}`,
            workerQueue: "main",
            queue: `task/${item.task}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        createdRuns.push({ runId: run.id, itemIndex });
        return { success: true, runId: run.friendlyId };
      });

      engine.setBatchCompletionCallback(async (result) => {
        completionResult = result;
      });

      try {
        const childTask = "child-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, [childTask]);

        // Phase 1: Initialize batch
        const { id: batchId, friendlyId: batchFriendlyId } = BatchId.generate();
        const runCount = 3;

        const initOptions: InitializeBatchOptions = {
          batchId,
          friendlyId: batchFriendlyId,
          environmentId: authenticatedEnvironment.id,
          environmentType: authenticatedEnvironment.type,
          organizationId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          runCount,
        };

        await engine.initializeBatch(initOptions);

        // Verify batch metadata is stored
        const progress = await engine.getBatchQueueProgress(batchId);
        expect(progress).not.toBeNull();
        expect(progress!.processedCount).toBe(0);
        expect(progress!.successCount).toBe(0);
        expect(progress!.failureCount).toBe(0);

        // Phase 2: Stream items one by one
        const items: BatchItem[] = [
          { task: childTask, payload: '{"item": 0}', payloadType: "application/json" },
          { task: childTask, payload: '{"item": 1}', payloadType: "application/json" },
          { task: childTask, payload: '{"item": 2}', payloadType: "application/json" },
        ];

        for (let i = 0; i < items.length; i++) {
          const result = await engine.enqueueBatchItem(
            batchId,
            authenticatedEnvironment.id,
            i,
            items[i]
          );
          expect(result.enqueued).toBe(true);
        }

        // Verify enqueued count
        const enqueuedCount = await engine.getBatchEnqueuedCount(batchId);
        expect(enqueuedCount).toBe(3);

        // Wait for all items to be processed
        await vi.waitFor(
          async () => {
            expect(createdRuns.length).toBe(3);
            expect(completionResult).not.toBeNull();
          },
          { timeout: 15000 }
        );

        // Verify completion result
        expect(completionResult!.batchId).toBe(batchId);
        expect(completionResult!.successfulRunCount).toBe(3);
        expect(completionResult!.failedRunCount).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "2-phase batch: items with same index are deduplicated",
    async ({ prisma, redisOptions }) => {
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
        batchQueue: {
          redis: redisOptions,
          consumerCount: 2,
          consumerIntervalMs: 50,
          drr: {
            quantum: 10,
            maxDeficit: 100,
          },
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      let processCount = 0;

      // Set up callbacks
      engine.setBatchProcessItemCallback(async ({ batchId, itemIndex, item, meta }) => {
        processCount++;
        return { success: true, runId: `run_${itemIndex}` };
      });

      engine.setBatchCompletionCallback(async () => {});

      try {
        const childTask = "child-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, [childTask]);

        // Initialize batch with 2 items
        const { id: batchId, friendlyId: batchFriendlyId } = BatchId.generate();

        await engine.initializeBatch({
          batchId,
          friendlyId: batchFriendlyId,
          environmentId: authenticatedEnvironment.id,
          environmentType: authenticatedEnvironment.type,
          organizationId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          runCount: 2,
        });

        const item: BatchItem = {
          task: childTask,
          payload: '{"item": 0}',
          payloadType: "application/json",
        };

        // Enqueue item at index 0
        const result1 = await engine.enqueueBatchItem(
          batchId,
          authenticatedEnvironment.id,
          0,
          item
        );
        expect(result1.enqueued).toBe(true);

        // Try to enqueue same index again - should be deduplicated
        const result2 = await engine.enqueueBatchItem(
          batchId,
          authenticatedEnvironment.id,
          0,
          item
        );
        expect(result2.enqueued).toBe(false);

        // Enqueue item at index 1
        const result3 = await engine.enqueueBatchItem(
          batchId,
          authenticatedEnvironment.id,
          1,
          item
        );
        expect(result3.enqueued).toBe(true);

        // Try to enqueue index 1 again - should be deduplicated
        const result4 = await engine.enqueueBatchItem(
          batchId,
          authenticatedEnvironment.id,
          1,
          item
        );
        expect(result4.enqueued).toBe(false);

        // Verify enqueued count shows 2 (not 4)
        const enqueuedCount = await engine.getBatchEnqueuedCount(batchId);
        expect(enqueuedCount).toBe(2);

        // Wait for processing to complete
        await vi.waitFor(
          async () => {
            expect(processCount).toBe(2);
          },
          { timeout: 15000 }
        );

        // Should have only processed 2 items total (not 4)
        expect(processCount).toBe(2);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "2-phase batch with parent blocking: parent is resumed when batch completes",
    async ({ prisma, redisOptions }) => {
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
        batchQueue: {
          redis: redisOptions,
          consumerCount: 2,
          consumerIntervalMs: 50,
          drr: {
            quantum: 10,
            maxDeficit: 100,
          },
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const createdRuns: Array<{ runId: string; itemIndex: number }> = [];
      let completionResult: CompleteBatchResult | null = null;

      // Set up callbacks
      engine.setBatchProcessItemCallback(async ({ batchId, itemIndex, item, meta }) => {
        const friendlyId = generateFriendlyId("run");
        const run = await engine.trigger(
          {
            friendlyId,
            environment: authenticatedEnvironment,
            taskIdentifier: item.task,
            payload: typeof item.payload === "string" ? item.payload : JSON.stringify(item.payload),
            payloadType: item.payloadType ?? "application/json",
            context: {},
            traceContext: {},
            traceId: `t_${batchId}_${itemIndex}`,
            spanId: `s_${batchId}_${itemIndex}`,
            workerQueue: "main",
            queue: `task/${item.task}`,
            isTest: false,
            tags: [],
            batch: {
              id: batchId,
              index: itemIndex,
            },
            resumeParentOnCompletion: meta.resumeParentOnCompletion,
          },
          prisma
        );

        // Update batch with run ID
        await prisma.batchTaskRun.update({
          where: { id: batchId },
          data: { runIds: { push: run.friendlyId } },
        });

        createdRuns.push({ runId: run.id, itemIndex });
        return { success: true, runId: run.friendlyId };
      });

      engine.setBatchCompletionCallback(async (result) => {
        completionResult = result;

        // Update batch in database
        await prisma.batchTaskRun.update({
          where: { id: result.batchId },
          data: {
            status: result.failedRunCount > 0 ? "PARTIAL_FAILED" : "PENDING",
            successfulRunCount: result.successfulRunCount,
            failedRunCount: result.failedRunCount,
          },
        });

        // Try to complete the batch
        await engine.tryCompleteBatch({ batchId: result.batchId });
      });

      try {
        const parentTask = "parent-task";
        const childTask = "child-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

        // Create the batch record in database
        const { id: batchId, friendlyId: batchFriendlyId } = BatchId.generate();

        const batch = await prisma.batchTaskRun.create({
          data: {
            id: batchId,
            friendlyId: batchFriendlyId,
            runtimeEnvironmentId: authenticatedEnvironment.id,
            status: "PENDING",
            runCount: 2,
            expectedCount: 2,
            batchVersion: "runengine:v2",
          },
        });

        // Trigger the parent run
        const parentRun = await engine.trigger(
          {
            friendlyId: generateFriendlyId("run"),
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

        // Block parent using the batch (Phase 1)
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

        // Initialize batch metadata in Redis
        await engine.initializeBatch({
          batchId,
          friendlyId: batchFriendlyId,
          environmentId: authenticatedEnvironment.id,
          environmentType: authenticatedEnvironment.type,
          organizationId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          runCount: 2,
          parentRunId: parentRun.id,
          resumeParentOnCompletion: true,
        });

        // Phase 2: Stream items
        const items: BatchItem[] = [
          { task: childTask, payload: '{"item": 0}', payloadType: "application/json" },
          { task: childTask, payload: '{"item": 1}', payloadType: "application/json" },
        ];

        for (let i = 0; i < items.length; i++) {
          await engine.enqueueBatchItem(batchId, authenticatedEnvironment.id, i, items[i]);
        }

        // Update batch status to PROCESSING
        await prisma.batchTaskRun.update({
          where: { id: batchId },
          data: { status: "PROCESSING", sealed: true, sealedAt: new Date() },
        });

        // Wait for items to be processed
        await vi.waitFor(
          async () => {
            expect(createdRuns.length).toBe(2);
            expect(completionResult).not.toBeNull();
          },
          { timeout: 15000 }
        );

        // Complete child runs
        for (const { runId, itemIndex } of createdRuns) {
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

          await engine.completeRunAttempt({
            runId: childAttempt.run.id,
            snapshotId: childAttempt.snapshot.id,
            completion: {
              id: runId,
              ok: true,
              output: `{"result":"success_${itemIndex}"}`,
              outputType: "application/json",
            },
          });
        }

        // Wait for parent to be unblocked
        await vi.waitFor(
          async () => {
            const waitpoints = await prisma.taskRunWaitpoint.findMany({
              where: { taskRunId: parentRun.id },
            });
            expect(waitpoints.length).toBe(0);
          },
          { timeout: 15000 }
        );

        // Parent should now be executing
        const parentAfterCompletion = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentAfterCompletion);
        expect(parentAfterCompletion.snapshot.executionStatus).toBe("EXECUTING");

        // Wait for batch to be marked COMPLETED
        await vi.waitFor(
          async () => {
            const batchRecord = await prisma.batchTaskRun.findUnique({
              where: { id: batch.id },
            });
            expect(batchRecord?.status).toBe("COMPLETED");
          },
          { timeout: 15000 }
        );
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "2-phase batch: expireBatch aborts an unsealed batch and resumes the parent with an error",
    async ({ prisma, redisOptions }) => {
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
        batchQueue: {
          redis: redisOptions,
          consumerCount: 2,
          consumerIntervalMs: 50,
          drr: {
            quantum: 10,
            maxDeficit: 100,
          },
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      // Phase 2 never runs for this batch, so neither callback should fire.
      engine.setBatchProcessItemCallback(async () => {
        return { success: true, runId: "should-not-be-called" };
      });
      engine.setBatchCompletionCallback(async () => {});

      try {
        const parentTask = "parent-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask]);

        // Phase 1: create the batch record (PENDING, unsealed) — mirrors CreateBatchService
        const { id: batchId, friendlyId: batchFriendlyId } = BatchId.generate();
        await prisma.batchTaskRun.create({
          data: {
            id: batchId,
            friendlyId: batchFriendlyId,
            runtimeEnvironmentId: authenticatedEnvironment.id,
            status: "PENDING",
            runCount: 2,
            expectedCount: 2,
            sealed: false,
            batchVersion: "runengine:v2",
          },
        });

        // Trigger and start the parent attempt
        const parentRun = await engine.trigger(
          {
            friendlyId: generateFriendlyId("run"),
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

        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(1);

        const initialExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(initialExecutionData);
        await engine.startRunAttempt({
          runId: parentRun.id,
          snapshotId: initialExecutionData.snapshot.id,
        });

        // Phase 1 continued: block the parent on the batch and initialize its metadata
        await engine.blockRunWithCreatedBatch({
          runId: parentRun.id,
          batchId,
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
          organizationId: authenticatedEnvironment.organizationId,
        });

        await engine.initializeBatch({
          batchId,
          friendlyId: batchFriendlyId,
          environmentId: authenticatedEnvironment.id,
          environmentType: authenticatedEnvironment.type,
          organizationId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          runCount: 2,
          parentRunId: parentRun.id,
          resumeParentOnCompletion: true,
        });

        const afterBlocked = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(afterBlocked);
        expect(afterBlocked.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        // Phase 2 never seals the batch. The seal-timeout reaper fires.
        await engine.expireBatch({ batchId });

        // The batch is terminally failed...
        const abortedBatch = await prisma.batchTaskRun.findUnique({ where: { id: batchId } });
        expect(abortedBatch?.status).toBe("ABORTED");
        expect(abortedBatch?.completedAt).not.toBeNull();

        // ...its waitpoint is completed with an error...
        const waitpoint = await prisma.waitpoint.findFirst({
          where: { completedByBatchId: batchId },
        });
        assertNonNullable(waitpoint);
        expect(waitpoint.status).toBe("COMPLETED");
        expect(waitpoint.outputIsError).toBe(true);

        // ...and the parent is unblocked and resumes instead of hanging forever.
        await vi.waitFor(
          async () => {
            const waitpoints = await prisma.taskRunWaitpoint.findMany({
              where: { taskRunId: parentRun.id },
            });
            expect(waitpoints.length).toBe(0);
          },
          { timeout: 15000 }
        );

        const parentAfter = await engine.getRunExecutionData({ runId: parentRun.id });
        assertNonNullable(parentAfter);
        expect(parentAfter.snapshot.executionStatus).toBe("EXECUTING");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "2-phase batch: a scheduled seal-timeout aborts an unsealed batch",
    async ({ prisma, redisOptions }) => {
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
        batchQueue: {
          redis: redisOptions,
          consumerCount: 2,
          consumerIntervalMs: 50,
          drr: {
            quantum: 10,
            maxDeficit: 100,
          },
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      engine.setBatchProcessItemCallback(async () => {
        return { success: true, runId: "should-not-be-called" };
      });
      engine.setBatchCompletionCallback(async () => {});

      try {
        // Phase 1: create + initialize the batch, but never stream/seal it.
        const { id: batchId, friendlyId: batchFriendlyId } = BatchId.generate();
        await prisma.batchTaskRun.create({
          data: {
            id: batchId,
            friendlyId: batchFriendlyId,
            runtimeEnvironmentId: authenticatedEnvironment.id,
            status: "PENDING",
            runCount: 3,
            expectedCount: 3,
            sealed: false,
            batchVersion: "runengine:v2",
          },
        });

        await engine.initializeBatch({
          batchId,
          friendlyId: batchFriendlyId,
          environmentId: authenticatedEnvironment.id,
          environmentType: authenticatedEnvironment.type,
          organizationId: authenticatedEnvironment.organizationId,
          projectId: authenticatedEnvironment.projectId,
          runCount: 3,
        });

        // Schedule the seal-timeout to fire immediately.
        await engine.scheduleExpireBatch({ batchId, availableAt: new Date() });

        // The worker picks up the job and aborts the unsealed batch.
        await vi.waitFor(
          async () => {
            const batchRecord = await prisma.batchTaskRun.findUnique({ where: { id: batchId } });
            expect(batchRecord?.status).toBe("ABORTED");
          },
          { timeout: 15000 }
        );
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "2-phase batch: error if batch not initialized",
    async ({ prisma, redisOptions }) => {
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
        batchQueue: {
          redis: redisOptions,
          consumerCount: 1,
          consumerIntervalMs: 50,
          drr: {
            quantum: 10,
            maxDeficit: 100,
          },
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const { id: batchId } = BatchId.generate();

        // Try to enqueue item for non-existent batch
        await expect(
          engine.enqueueBatchItem(batchId, authenticatedEnvironment.id, 0, {
            task: "test-task",
            payload: "{}",
            payloadType: "application/json",
          })
        ).rejects.toThrow(/not found or not initialized/);
      } finally {
        await engine.quit();
      }
    }
  );
});
