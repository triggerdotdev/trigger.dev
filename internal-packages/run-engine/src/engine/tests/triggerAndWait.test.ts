import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "node:timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine triggerAndWait", () => {
  containerTest("triggerAndWait", async ({ prisma, redisOptions }) => {
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
          queue: `task/${parentTask}`,
          isTest: false,
          tags: [],
          workerQueue: "main",
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
          queue: `task/${childTask}`,
          isTest: false,
          tags: [],
          resumeParentOnCompletion: true,
          parentTaskRunId: parentRun.id,
          workerQueue: "main",
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
      await setTimeout(500);
      const dequeuedChild = await engine.dequeueFromWorkerQueue({
        consumerId: "test_12345",
        workerQueue: "main",
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

      await setTimeout(500);

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
      expect(parentExecutionDataAfter.completedWaitpoints![0].completedByTaskRun?.id).toBe(
        childRun.id
      );
      expect(parentExecutionDataAfter.completedWaitpoints![0].output).toBe('{"foo":"bar"}');
    } finally {
      await engine.quit();
    }
  });

  /** This happens if you `triggerAndWait` with an idempotencyKey if that run is in progress  */
  containerTest(
    "triggerAndWait two runs with shared awaited child",
    async ({ prisma, redisOptions }) => {
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

        //trigger the run
        const parentRun1 = await engine.trigger(
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
            queue: `task/${parentTask}`,
            isTest: false,
            tags: [],
            workerQueue: "main",
          },
          prisma
        );

        //dequeue parent and create the attempt
        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        const attemptResult = await engine.startRunAttempt({
          runId: parentRun1.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        //trigger the child
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
            queue: `task/${childTask}`,
            isTest: false,
            tags: [],
            resumeParentOnCompletion: true,
            parentTaskRunId: parentRun1.id,
            workerQueue: "main",
          },
          prisma
        );

        const childExecutionData = await engine.getRunExecutionData({ runId: childRun.id });
        assertNonNullable(childExecutionData);
        expect(childExecutionData.snapshot.executionStatus).toBe("QUEUED");

        const parentExecutionData = await engine.getRunExecutionData({ runId: parentRun1.id });
        assertNonNullable(parentExecutionData);
        expect(parentExecutionData.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        //check the waitpoint blocking the parent run
        const runWaitpoint = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: parentRun1.id,
          },
          include: {
            waitpoint: true,
          },
        });
        assertNonNullable(runWaitpoint);
        expect(runWaitpoint.waitpoint.type).toBe("RUN");
        expect(runWaitpoint.waitpoint.completedByTaskRunId).toBe(childRun.id);

        //dequeue the child run
        await setTimeout(500);
        const dequeuedChild = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });

        //start the child run
        const childAttempt = await engine.startRunAttempt({
          runId: childRun.id,
          snapshotId: dequeuedChild[0].snapshot.id,
        });

        //trigger a second parent run
        const parentRun2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_p1235",
            environment: authenticatedEnvironment,
            taskIdentifier: parentTask,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            queue: `task/${parentTask}`,
            isTest: false,
            tags: [],
            workerQueue: "main",
          },
          prisma
        );
        //dequeue 2nd parent
        await setTimeout(500);
        const dequeued2 = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });

        //create the 2nd parent attempt
        const attemptResultParent2 = await engine.startRunAttempt({
          runId: parentRun2.id,
          snapshotId: dequeued2[0].snapshot.id,
        });

        //block the 2nd parent run with the child
        const childRunWithWaitpoint = await prisma.taskRun.findUniqueOrThrow({
          where: { id: childRun.id },
          include: {
            associatedWaitpoint: true,
          },
        });
        const blockedResult = await engine.blockRunWithWaitpoint({
          runId: parentRun2.id,
          waitpoints: childRunWithWaitpoint.associatedWaitpoint!.id,
          projectId: authenticatedEnvironment.project.id,
          organizationId: authenticatedEnvironment.organizationId,
          tx: prisma,
        });
        expect(blockedResult.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");
        const parent2ExecutionData = await engine.getRunExecutionData({ runId: parentRun2.id });
        assertNonNullable(parent2ExecutionData);
        expect(parent2ExecutionData.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

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

        await setTimeout(500);

        const parent1RunWaitpointAfter = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: parentRun1.id,
          },
        });
        expect(parent1RunWaitpointAfter).toBeNull();

        const parent2RunWaitpointAfter = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: parentRun2.id,
          },
        });
        expect(parent2RunWaitpointAfter).toBeNull();

        //parent snapshot
        const parentExecutionDataAfter = await engine.getRunExecutionData({ runId: parentRun1.id });
        assertNonNullable(parentExecutionDataAfter);
        expect(parentExecutionDataAfter.snapshot.executionStatus).toBe("EXECUTING");
        expect(parentExecutionDataAfter.completedWaitpoints?.length).toBe(1);
        expect(parentExecutionDataAfter.completedWaitpoints![0].id).toBe(runWaitpoint.waitpointId);
        expect(parentExecutionDataAfter.completedWaitpoints![0].completedByTaskRun?.id).toBe(
          childRun.id
        );
        expect(parentExecutionDataAfter.completedWaitpoints![0].output).toBe('{"foo":"bar"}');

        //parent 2 snapshot
        const parent2ExecutionDataAfter = await engine.getRunExecutionData({
          runId: parentRun2.id,
        });
        assertNonNullable(parent2ExecutionDataAfter);
        expect(parent2ExecutionDataAfter.snapshot.executionStatus).toBe("EXECUTING");
        expect(parent2ExecutionDataAfter.completedWaitpoints?.length).toBe(1);
        expect(parent2ExecutionDataAfter.completedWaitpoints![0].id).toBe(
          childRunWithWaitpoint.associatedWaitpoint!.id
        );
        expect(parentExecutionDataAfter.completedWaitpoints![0].completedByTaskRun?.id).toBe(
          childRun.id
        );
        expect(parent2ExecutionDataAfter.completedWaitpoints![0].output).toBe('{"foo":"bar"}');
      } finally {
        await engine.quit();
      }
    }
  );
});
