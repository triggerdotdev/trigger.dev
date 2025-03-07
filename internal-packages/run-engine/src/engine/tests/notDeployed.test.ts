import {
  containerTest,
  setupAuthenticatedEnvironment,
  setupBackgroundWorker,
  assertNonNullable,
} from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine not deployed", () => {
  containerTest("Not yet deployed", async ({ prisma, redisOptions }) => {
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
          masterQueue: "main",
          queueName: "task/test-task",
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
          masterQueue: "main",
          queueName: "task/test-task",
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

      //dequeuing should fail
      const dequeued = await engine.dequeueFromMasterQueue({
        consumerId: "test_12345",
        masterQueue: run.masterQueue,
        maxRunCount: 10,
      });
      expect(dequeued.length).toBe(0);

      //queue should be empty
      const queueLength = await engine.runQueue.lengthOfQueue(authenticatedEnvironment, run.queue);
      expect(queueLength).toBe(0);

      //check the execution data now
      const executionData2R1 = await engine.getRunExecutionData({ runId: run.id });
      const executionData2R2 = await engine.getRunExecutionData({ runId: run2.id });
      assertNonNullable(executionData2R1);
      assertNonNullable(executionData2R2);
      expect(executionData2R1.snapshot.executionStatus).toBe("RUN_CREATED");
      expect(executionData2R2.snapshot.executionStatus).toBe("RUN_CREATED");
      expect(executionData2R1.run.status).toBe("WAITING_FOR_DEPLOY");
      expect(executionData2R2.run.status).toBe("WAITING_FOR_DEPLOY");

      //create background worker
      const backgroundWorker = await setupBackgroundWorker(
        prisma,
        authenticatedEnvironment,
        taskIdentifier
      );

      //now we deploy the background worker
      await engine.queueRunsWaitingForWorker({ backgroundWorkerId: backgroundWorker.worker.id });

      //it's async so we wait
      await setTimeout(500);

      //should now be queued
      const executionData3R1 = await engine.getRunExecutionData({ runId: run.id });
      const executionData3R2 = await engine.getRunExecutionData({ runId: run2.id });
      assertNonNullable(executionData3R1);
      assertNonNullable(executionData3R2);
      expect(executionData3R1.snapshot.executionStatus).toBe("QUEUED");
      expect(executionData3R2.snapshot.executionStatus).toBe("QUEUED");
      expect(executionData3R1.run.status).toBe("PENDING");
      expect(executionData3R2.run.status).toBe("PENDING");

      //queue should be empty
      const queueLength2 = await engine.runQueue.lengthOfQueue(authenticatedEnvironment, run.queue);
      expect(queueLength2).toBe(2);
    } finally {
      engine.quit();
    }
  });
});
