import {
  assertNonNullable,
  containerTest,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
} from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";

describe("RunEngine Waitpoints", () => {
  containerTest("waitForDuration", { timeout: 15_000 }, async ({ prisma, redisContainer }) => {
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
      const taskIdentifier = "test-task";

      //create background worker
      await setupBackgroundWorker(prisma, authenticatedEnvironment, taskIdentifier);

      //trigger the run
      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_p1234",
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

      //dequeue the run
      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });

      //create an attempt
      const attemptResult = await engine.startRunAttempt({
        runId: dequeued[0].run.id,
        snapshotId: dequeued[0].snapshot.id,
      });
      expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

      //waitForDuration
      const date = new Date(Date.now() + 1000);
      const result = await engine.waitForDuration({
        runId: run.id,
        snapshotId: attemptResult.snapshot.id,
        date,
        releaseConcurrency: false,
      });

      expect(result.willWaitUntil.toISOString()).toBe(date.toISOString());

      const executionData = await engine.getRunExecutionData({ runId: run.id });
      expect(executionData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

      await setTimeout(1_500);

      const executionDataAfter = await engine.getRunExecutionData({ runId: run.id });
      expect(executionDataAfter?.snapshot.executionStatus).toBe("EXECUTING");
    } finally {
      engine.quit();
    }
  });

  containerTest(
    "Waitpoints cleared if attempt fails",
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
        const taskIdentifier = "test-task";

        //create background worker
        await setupBackgroundWorker(prisma, authenticatedEnvironment, taskIdentifier);

        //trigger the run
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_p1234",
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

        //dequeue the run
        const dequeued = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: run.masterQueue,
          maxRunCount: 10,
        });

        //create an attempt
        const attemptResult = await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });
        expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");

        //waitForDuration
        const date = new Date(Date.now() + 60_000);
        const result = await engine.waitForDuration({
          runId: run.id,
          snapshotId: attemptResult.snapshot.id,
          date,
          releaseConcurrency: false,
        });

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        expect(executionData?.snapshot.executionStatus).toBe("EXECUTING_WITH_WAITPOINTS");

        //fail the attempt (user error)
        const error = {
          type: "BUILT_IN_ERROR" as const,
          name: "UserError",
          message: "This is a user error",
          stackTrace: "Error: This is a user error\n    at <anonymous>:1:1",
        };
        const failResult = await engine.completeRunAttempt({
          runId: executionData!.run.id,
          snapshotId: executionData!.snapshot.id,
          completion: {
            ok: false,
            id: executionData!.run.id,
            error,
            retry: {
              timestamp: Date.now(),
              delay: 0,
            },
          },
        });
        expect(failResult).toBe("RETRY_IMMEDIATELY");

        const executionData2 = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData2);
        expect(executionData2.snapshot.executionStatus).toBe("PENDING_EXECUTING");
        expect(executionData2.run.attemptNumber).toBe(1);
        expect(executionData2.run.status).toBe("RETRYING_AFTER_FAILURE");
        expect(executionData2.completedWaitpoints.length).toBe(0);

        //check the waitpoint blocking the parent run
        const runWaitpoint = await prisma.taskRunWaitpoint.findFirst({
          where: {
            taskRunId: run.id,
          },
          include: {
            waitpoint: true,
          },
        });
        expect(runWaitpoint).toBeNull();
      } finally {
        engine.quit();
      }
    }
  );
});
