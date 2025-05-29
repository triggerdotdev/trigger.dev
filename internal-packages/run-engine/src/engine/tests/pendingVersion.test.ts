import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { DequeuedMessage } from "@trigger.dev/core/v3";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine pending version", () => {
  containerTest(
    "When a run is triggered but the background task hasn't been created yet",
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
          processWorkerQueueDebounceMs: 50,
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
        //set this so we have to requeue the runs in two batches
        queueRunsWaitingForWorkerBatchSize: 1,
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

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
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        //trigger another run
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_1235",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        //should be queued
        const executionDataR1 = await engine.getRunExecutionData({ runId: run.id });
        const executionDataR2 = await engine.getRunExecutionData({ runId: run2.id });
        assertNonNullable(executionDataR1);
        assertNonNullable(executionDataR2);
        expect(executionDataR1.snapshot.executionStatus).toBe("QUEUED");
        expect(executionDataR2.snapshot.executionStatus).toBe("QUEUED");

        await setupBackgroundWorker(engine, authenticatedEnvironment, ["test-task-other"]);

        await setTimeout(500);

        const dequeued: DequeuedMessage[] = [];
        for (let i = 0; i < 2; i++) {
          dequeued.push(
            ...(await engine.dequeueFromWorkerQueue({
              consumerId: "test_12345",
              workerQueue: "main",
            }))
          );
        }
        expect(dequeued.length).toBe(0);

        //queue should be empty
        const queueLength = await engine.runQueue.lengthOfQueue(
          authenticatedEnvironment,
          run.queue
        );
        expect(queueLength).toBe(0);

        //check the execution data now
        const executionData2R1 = await engine.getRunExecutionData({ runId: run.id });
        const executionData2R2 = await engine.getRunExecutionData({ runId: run2.id });
        assertNonNullable(executionData2R1);
        assertNonNullable(executionData2R2);
        expect(executionData2R1.snapshot.executionStatus).toBe("RUN_CREATED");
        expect(executionData2R2.snapshot.executionStatus).toBe("RUN_CREATED");
        expect(executionData2R1.run.status).toBe("PENDING_VERSION");
        expect(executionData2R2.run.status).toBe("PENDING_VERSION");

        //create background worker
        const backgroundWorker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier
        );

        //it's async so we wait
        await setTimeout(1000);

        //should now be queued
        const executionData3R1 = await engine.getRunExecutionData({ runId: run.id });
        const executionData3R2 = await engine.getRunExecutionData({ runId: run2.id });
        assertNonNullable(executionData3R1);
        assertNonNullable(executionData3R2);
        expect(executionData3R1.snapshot.executionStatus).toBe("QUEUED");
        expect(executionData3R2.snapshot.executionStatus).toBe("QUEUED");
        expect(executionData3R1.run.status).toBe("PENDING");
        expect(executionData3R2.run.status).toBe("PENDING");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "When a run is triggered but the queue hasn't been created yet",
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
          processWorkerQueueDebounceMs: 50,
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
        //set this so we have to requeue the runs in two batches
        queueRunsWaitingForWorkerBatchSize: 1,
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

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
            queue: "custom-queue",
            isTest: false,
            tags: [],
          },
          prisma
        );

        //trigger another run
        const run2 = await engine.trigger(
          {
            number: 2,
            friendlyId: "run_1235",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12346",
            spanId: "s12346",
            queue: "custom-queue-2",
            isTest: false,
            tags: [],
          },
          prisma
        );

        //should be queued
        const executionDataR1 = await engine.getRunExecutionData({ runId: run.id });
        const executionDataR2 = await engine.getRunExecutionData({ runId: run2.id });
        assertNonNullable(executionDataR1);
        assertNonNullable(executionDataR2);
        expect(executionDataR1.snapshot.executionStatus).toBe("QUEUED");
        expect(executionDataR2.snapshot.executionStatus).toBe("QUEUED");

        await setTimeout(500);

        //dequeuing should fail
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(0);

        //queue should be empty
        const queueLength = await engine.runQueue.lengthOfQueue(
          authenticatedEnvironment,
          run.queue
        );
        expect(queueLength).toBe(0);

        //check the execution data now
        const executionData2R1 = await engine.getRunExecutionData({ runId: run.id });
        const executionData2R2 = await engine.getRunExecutionData({ runId: run2.id });
        assertNonNullable(executionData2R1);
        assertNonNullable(executionData2R2);
        expect(executionData2R1.snapshot.executionStatus).toBe("RUN_CREATED");
        expect(executionData2R2.snapshot.executionStatus).toBe("RUN_CREATED");
        expect(executionData2R1.run.status).toBe("PENDING_VERSION");
        expect(executionData2R2.run.status).toBe("PENDING_VERSION");

        //create background worker
        const backgroundWorker = await setupBackgroundWorker(
          engine,
          authenticatedEnvironment,
          taskIdentifier,
          undefined,
          undefined,
          {
            customQueues: ["custom-queue", "custom-queue-2"],
          }
        );

        //it's async so we wait
        await setTimeout(1000);

        //should now be queued
        const executionData3R1 = await engine.getRunExecutionData({ runId: run.id });
        const executionData3R2 = await engine.getRunExecutionData({ runId: run2.id });
        assertNonNullable(executionData3R1);
        assertNonNullable(executionData3R2);
        expect(executionData3R1.snapshot.executionStatus).toBe("QUEUED");
        expect(executionData3R2.snapshot.executionStatus).toBe("QUEUED");
        expect(executionData3R1.run.status).toBe("PENDING");
        expect(executionData3R2.run.status).toBe("PENDING");
      } finally {
        await engine.quit();
      }
    }
  );
});
