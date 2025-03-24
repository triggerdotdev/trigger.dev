import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine delays", () => {
  containerTest("Run start delayed", async ({ prisma, redisOptions }) => {
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
        engine,
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
          queue: "task/test-task",
          isTest: false,
          tags: [],
          delayUntil: new Date(Date.now() + 500),
        },
        prisma
      );

      //should be created but not queued yet
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("RUN_CREATED");

      //wait for 1 seconds
      await setTimeout(1_000);

      //should now be queued
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("QUEUED");
    } finally {
      engine.quit();
    }
  });

  containerTest("Rescheduling a delayed run", async ({ prisma, redisOptions }) => {
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
        engine,
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
          queue: "task/test-task",
          isTest: false,
          tags: [],
          delayUntil: new Date(Date.now() + 400),
        },
        prisma
      );

      //should be created but not queued yet
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("RUN_CREATED");

      const rescheduleTo = new Date(Date.now() + 1_500);
      const updatedRun = await engine.rescheduleDelayedRun({
        runId: run.id,
        delayUntil: rescheduleTo,
      });
      expect(updatedRun.delayUntil?.toISOString()).toBe(rescheduleTo.toISOString());

      //wait so the initial delay passes
      await setTimeout(1_000);

      //should still be created
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("RUN_CREATED");

      //wait so the updated delay passes
      await setTimeout(1_750);

      //should now be queued
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("QUEUED");
    } finally {
      engine.quit();
    }
  });

  containerTest("Delayed run with a ttl", async ({ prisma, redisOptions }) => {
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
        engine,
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
          queue: "task/test-task",
          isTest: false,
          tags: [],
          delayUntil: new Date(Date.now() + 1000),
          ttl: "2s",
        },
        prisma
      );

      //should be created but not queued yet
      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("RUN_CREATED");
      expect(run.status).toBe("DELAYED");

      //wait for 1 seconds
      await setTimeout(2_500);

      //should now be queued
      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("QUEUED");

      const run2 = await prisma.taskRun.findFirstOrThrow({
        where: { id: run.id },
      });

      expect(run2.status).toBe("PENDING");

      //wait for 3 seconds
      await setTimeout(3_000);

      //should now be expired
      const executionData3 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData3);
      expect(executionData3.snapshot.executionStatus).toBe("FINISHED");

      const run3 = await prisma.taskRun.findFirstOrThrow({
        where: { id: run.id },
      });

      expect(run3.status).toBe("EXPIRED");
    } finally {
      engine.quit();
    }
  });
});
