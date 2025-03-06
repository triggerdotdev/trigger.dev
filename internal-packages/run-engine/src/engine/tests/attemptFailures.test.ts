import {
  assertNonNullable,
  containerTest,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
} from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { expect } from "vitest";
import { EventBusEventArgs } from "../eventBus.js";
import { RunEngine } from "../index.js";

describe("RunEngine attempt failures", () => {
  containerTest(
    "Single run (retry attempt, then succeed)",
    { timeout: 15_000 },
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

        //create background worker
        const backgroundWorker = await setupBackgroundWorker(
          prisma,
          authenticatedEnvironment,
          taskIdentifier
        );

        //trigger the run
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

        //fail the attempt
        const error = {
          type: "BUILT_IN_ERROR" as const,
          name: "UserError",
          message: "This is a user error",
          stackTrace: "Error: This is a user error\n    at <anonymous>:1:1",
        };
        const result = await engine.completeRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: attemptResult.snapshot.id,
          completion: {
            ok: false,
            id: dequeued[0].run.id,
            error,
            retry: {
              timestamp: Date.now(),
              delay: 0,
            },
          },
        });
        expect(result.attemptStatus).toBe("RETRY_IMMEDIATELY");
        expect(result.snapshot.executionStatus).toBe("PENDING_EXECUTING");
        expect(result.run.status).toBe("RETRYING_AFTER_FAILURE");

        //state should be completed
        const executionData3 = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData3);
        expect(executionData3.snapshot.executionStatus).toBe("PENDING_EXECUTING");
        //only when the new attempt is created, should the attempt be increased
        expect(executionData3.run.attemptNumber).toBe(1);
        expect(executionData3.run.status).toBe("RETRYING_AFTER_FAILURE");

        //create a second attempt
        const attemptResult2 = await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: executionData3.snapshot.id,
        });
        expect(attemptResult2.run.attemptNumber).toBe(2);

        //now complete it successfully
        const result2 = await engine.completeRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: attemptResult2.snapshot.id,
          completion: {
            ok: true,
            id: dequeued[0].run.id,
            output: `{"foo":"bar"}`,
            outputType: "application/json",
          },
        });
        expect(result2.snapshot.executionStatus).toBe("FINISHED");
        expect(result2.run.attemptNumber).toBe(2);
        expect(result2.run.status).toBe("COMPLETED_SUCCESSFULLY");

        //waitpoint should have been completed, with the output
        const runWaitpointAfter = await prisma.waitpoint.findMany({
          where: {
            completedByTaskRunId: run.id,
          },
        });
        expect(runWaitpointAfter.length).toBe(1);
        expect(runWaitpointAfter[0].type).toBe("RUN");
        expect(runWaitpointAfter[0].output).toBe(`{"foo":"bar"}`);
        expect(runWaitpointAfter[0].outputIsError).toBe(false);

        //state should be completed
        const executionData4 = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData4);
        expect(executionData4.snapshot.executionStatus).toBe("FINISHED");
        expect(executionData4.run.attemptNumber).toBe(2);
        expect(executionData4.run.status).toBe("COMPLETED_SUCCESSFULLY");
      } finally {
        engine.quit();
      }
    }
  );
});
