import {
  assertNonNullable,
  containerTest,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
} from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "node:timers/promises";
import { generateFriendlyId } from "@trigger.dev/core/v3/apps";

describe("RunEngine batchTriggerAndWait", () => {
  containerTest(
    "batchTriggerAndWait (no idempotency)",
    { timeout: 15_000 },
    async ({ prisma, redisContainer }) => {
      //create environment
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const engine = new RunEngine({
        prisma,
        redis: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
          enableAutoPipelining: true,
        },
        worker: {
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
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
        await setupBackgroundWorker(prisma, authenticatedEnvironment, [parentTask, childTask]);

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
            queueName: `task/${parentTask}`,
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
            queueName: `task/${childTask}`,
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
            queueName: `task/${childTask}`,
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
        expect(runWaitpoints.length).toBe(2);
        expect(runWaitpoints[0].waitpoint.type).toBe("RUN");
        expect(runWaitpoints[0].waitpoint.completedByTaskRunId).toBe(child1.id);
        expect(runWaitpoints[0].batchId).toBe(batch.id);
        expect(runWaitpoints[0].batchIndex).toBe(0);
        expect(runWaitpoints[1].waitpoint.type).toBe("RUN");
        expect(runWaitpoints[1].waitpoint.completedByTaskRunId).toBe(child2.id);
        expect(runWaitpoints[1].batchId).toBe(batch.id);
        expect(runWaitpoints[1].batchIndex).toBe(1);

        //dequeue and start the 1st child
        const dequeuedChild = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: child1.masterQueue,
          maxRunCount: 1,
        });
        const childAttempt1 = await engine.startRunAttempt({
          runId: child1.id,
          snapshotId: dequeuedChild[0].snapshot.id,
        });

        // complete the 1st child
        await engine.completeRunAttempt({
          runId: child1.id,
          snapshotId: childAttempt1.snapshot.id,
          completion: {
            id: child1.id,
            ok: true,
            output: '{"foo":"bar"}',
            outputType: "application/json",
          },
        });

        //child snapshot
        const childExecutionDataAfter = await engine.getRunExecutionData({ runId: child1.id });
        assertNonNullable(childExecutionDataAfter);
        expect(childExecutionDataAfter.snapshot.executionStatus).toBe("FINISHED");

        const child1WaitpointAfter = await prisma.waitpoint.findFirst({
          where: {
            id: runWaitpoints[0].waitpointId,
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
        expect(runWaitpointsAfterFirstChild.length).toBe(2);

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
        const dequeuedChild2 = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: child2.masterQueue,
          maxRunCount: 1,
        });
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
            id: runWaitpoints[1].waitpointId,
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
        expect(parentExecutionDataAfterSecondChildComplete.snapshot.executionStatus).toBe(
          "EXECUTING"
        );
        expect(parentExecutionDataAfterSecondChildComplete.batch?.id).toBe(batch.id);
        expect(parentExecutionDataAfterSecondChildComplete.completedWaitpoints.length).toBe(2);

        const completedWaitpoint0 =
          parentExecutionDataAfterSecondChildComplete.completedWaitpoints![0];
        expect(completedWaitpoint0.id).toBe(runWaitpoints[0].waitpointId);
        expect(completedWaitpoint0.completedByTaskRun?.id).toBe(child1.id);
        expect(completedWaitpoint0.output).toBe('{"foo":"bar"}');
        expect(completedWaitpoint0.index).toBe(0);

        const completedWaitpoint1 =
          parentExecutionDataAfterSecondChildComplete.completedWaitpoints![1];
        expect(completedWaitpoint1.id).toBe(runWaitpoints[1].waitpointId);
        expect(completedWaitpoint1.completedByTaskRun?.id).toBe(child2.id);
        expect(completedWaitpoint1.output).toBe('{"baz":"qux"}');
        expect(completedWaitpoint1.index).toBe(1);
      } finally {
        engine.quit();
      }
    }
  );
});
