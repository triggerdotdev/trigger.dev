import {
  containerTest,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
  assertNonNullable,
} from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";

describe("RunEngine heartbeats", () => {
  containerTest(
    "Attempt timeout then successfully attempted",
    { timeout: 15_000 },
    async ({ prisma, redisContainer }) => {
      //create environment
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const pendingExecutingTimeout = 100;

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
        heartbeatTimeoutsMs: {
          PENDING_EXECUTING: pendingExecutingTimeout,
        },
        queue: {
          retryOptions: {
            maxTimeoutInMs: 50,
          },
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

        //expect it to be pending with 0 consecutiveFailures
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("PENDING_EXECUTING");

        await setTimeout(pendingExecutingTimeout * 2);

        //expect it to be pending with 3 consecutiveFailures
        const executionData2 = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData2);
        expect(executionData2.snapshot.executionStatus).toBe("QUEUED");

        await setTimeout(500);

        //have to dequeue again
        const dequeued2 = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: run.masterQueue,
          maxRunCount: 10,
        });
        expect(dequeued2.length).toBe(1);

        // create an attempt
        const attemptResult = await engine.startRunAttempt({
          runId: dequeued2[0].run.id,
          snapshotId: dequeued2[0].snapshot.id,
        });
        expect(attemptResult.run.id).toBe(run.id);
        expect(attemptResult.run.status).toBe("EXECUTING");
        expect(attemptResult.snapshot.executionStatus).toBe("EXECUTING");
      } finally {
        engine.quit();
      }
    }
  );

  containerTest(
    "All start attempts timeout",
    { timeout: 15_000 },
    async ({ prisma, redisContainer }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const pendingExecutingTimeout = 100;

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
        heartbeatTimeoutsMs: {
          PENDING_EXECUTING: pendingExecutingTimeout,
        },
        queue: {
          retryOptions: {
            //intentionally set the attempts to 2 and quick
            maxAttempts: 2,
            minTimeoutInMs: 50,
            maxTimeoutInMs: 50,
          },
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

        //expect it to be pending
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("PENDING_EXECUTING");

        await setTimeout(pendingExecutingTimeout * 2);

        //expect it to be pending with 3 consecutiveFailures
        const executionData2 = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData2);
        expect(executionData2.snapshot.executionStatus).toBe("QUEUED");

        await setTimeout(500);

        //have to dequeue again
        const dequeued2 = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: run.masterQueue,
          maxRunCount: 10,
        });
        expect(dequeued2.length).toBe(1);

        //expect it to be pending
        const executionData3 = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData3);
        expect(executionData3.snapshot.executionStatus).toBe("PENDING_EXECUTING");

        await setTimeout(pendingExecutingTimeout * 3);

        //expect it to be pending with 3 consecutiveFailures
        const executionData4 = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData4);
        expect(executionData4.snapshot.executionStatus).toBe("FINISHED");
        expect(executionData4.run.status).toBe("SYSTEM_FAILURE");
      } finally {
        engine.quit();
      }
    }
  );

  //todo heartbeat failing and the run eventually failing with a system failure
});
