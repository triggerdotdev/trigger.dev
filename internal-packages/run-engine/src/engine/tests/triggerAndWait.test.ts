import {
  assertNonNullable,
  containerTest,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
} from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { expect } from "vitest";
import { RunEngine } from "../index.js";

describe("RunEngine triggerAndWait", () => {
  containerTest("triggerAndWait", { timeout: 15_000 }, async ({ prisma, redisContainer }) => {
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
          masterQueue: "main",
          queueName: `task/${childTask}`,
          isTest: false,
          tags: [],
          resumeParentOnCompletion: true,
          parentTaskRunId: parentRun.id,
        },
        prisma
      );

      const childExecutionData = await engine.getRunExecutionData({ runId: childRun.id });
      assertNonNullable(childExecutionData);
      expect(childExecutionData.snapshot.executionStatus).toBe("QUEUED");

      const parentExecutionData = await engine.getRunExecutionData({ runId: parentRun.id });
      assertNonNullable(parentExecutionData);
      expect(parentExecutionData.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      //check the waitpoint blocking the parent run
      const runWaitpoint = await prisma.taskRunWaitpoint.findFirst({
        where: {
          taskRunId: parentRun.id,
        },
        include: {
          waitpoint: true,
        },
      });
      assertNonNullable(runWaitpoint);
      expect(runWaitpoint.waitpoint.type).toBe("RUN");
      expect(runWaitpoint.waitpoint.completedByTaskRunId).toBe(childRun.id);

      //dequeue the child run
      const dequeuedChild = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: childRun.masterQueue,
        maxRunCount: 10,
      });

      //start the child run
      const childAttempt = await engine.startRunAttempt({
        runId: childRun.id,
        snapshotId: dequeuedChild[0].snapshot.id,
      });

      // complete the child run
      await engine.completeRunAttempt({
        runId: childRun.id,
        snapshotId: childAttempt.snapshot.id,
        completion: {
          id: childRun.id,
          ok: true,
          output: '{"foo":"bar"}',
          outputType: "application/json",
        },
      });

      //child snapshot
      const childExecutionDataAfter = await engine.getRunExecutionData({ runId: childRun.id });
      assertNonNullable(childExecutionDataAfter);
      expect(childExecutionDataAfter.snapshot.executionStatus).toBe("FINISHED");

      const waitpointAfter = await prisma.waitpoint.findFirst({
        where: {
          id: runWaitpoint.waitpointId,
        },
      });
      expect(waitpointAfter?.completedAt).not.toBeNull();
      expect(waitpointAfter?.status).toBe("COMPLETED");
      expect(waitpointAfter?.output).toBe('{"foo":"bar"}');

      const runWaitpointAfter = await prisma.taskRunWaitpoint.findFirst({
        where: {
          taskRunId: parentRun.id,
        },
        include: {
          waitpoint: true,
        },
      });
      expect(runWaitpointAfter).toBeNull();

      //parent snapshot
      const parentExecutionDataAfter = await engine.getRunExecutionData({ runId: parentRun.id });
      assertNonNullable(parentExecutionDataAfter);
      expect(parentExecutionDataAfter.snapshot.executionStatus).toBe("EXECUTING");
      expect(parentExecutionDataAfter.completedWaitpoints?.length).toBe(1);
      expect(parentExecutionDataAfter.completedWaitpoints![0].id).toBe(runWaitpoint.waitpointId);
      expect(parentExecutionDataAfter.completedWaitpoints![0].completedByTaskRunId).toBe(
        childRun.id
      );
      expect(parentExecutionDataAfter.completedWaitpoints![0].output).toBe('{"foo":"bar"}');
    } finally {
      engine.quit();
    }
  });
});
