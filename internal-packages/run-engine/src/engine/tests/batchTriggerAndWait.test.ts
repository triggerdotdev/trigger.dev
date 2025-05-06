import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect, describe } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "node:timers/promises";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

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
      expect(parentExecutionDataAfterFirstChildComplete.snapshot.executionStatus).toBe(
        "EXECUTING_WITH_WAITPOINTS"
      );
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
            masterQueue: "main",
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
        const dequeuedBatchChild = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: batchChild.masterQueue,
          maxRunCount: 1,
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
            masterQueue: "main",
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
});
