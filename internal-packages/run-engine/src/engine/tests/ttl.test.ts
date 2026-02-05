import { containerTest, assertNonNullable } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "timers/promises";
import { EventBusEventArgs } from "../eventBus.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine ttl", () => {
  containerTest("Run expiring (ttl)", async ({ prisma, redisOptions }) => {
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
        ttlSystem: {
          pollIntervalMs: 100,
          batchSize: 10,
        },
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
          workerQueue: "main",
          queue: "task/test-task",
          isTest: false,
          tags: [],
          ttl: "1s",
        },
        prisma
      );

      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("QUEUED");

      let expiredEventData: EventBusEventArgs<"runExpired">[0] | undefined = undefined;
      engine.eventBus.on("runExpired", (result) => {
        expiredEventData = result;
      });

      //wait for 1 seconds
      await setTimeout(1_500);

      assertNonNullable(expiredEventData);
      const assertedExpiredEventData = expiredEventData as EventBusEventArgs<"runExpired">[0];
      expect(assertedExpiredEventData.run.spanId).toBe(run.spanId);

      const executionData2 = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData2);
      expect(executionData2.snapshot.executionStatus).toBe("FINISHED");
      expect(executionData2.run.attemptNumber).toBe(undefined);
      expect(executionData2.run.status).toBe("EXPIRED");

      //concurrency should have been released
      const envConcurrencyCompleted = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );
      expect(envConcurrencyCompleted).toBe(0);
    } finally {
      await engine.quit();
    }
  });

  containerTest("Multiple runs expiring via TTL batch", async ({ prisma, redisOptions }) => {
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const expiredEvents: EventBusEventArgs<"runExpired">[0][] = [];

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
        ttlSystem: {
          pollIntervalMs: 100,
          batchSize: 10,
        },
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

      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      engine.eventBus.on("runExpired", (result) => {
        expiredEvents.push(result);
      });

      // Trigger multiple runs with short TTL
      const runs = await Promise.all(
        [1, 2, 3].map((n) =>
          engine.trigger(
            {
              number: n,
              friendlyId: `run_b${n}234`,
              environment: authenticatedEnvironment,
              taskIdentifier,
              payload: "{}",
              payloadType: "application/json",
              context: {},
              traceContext: {},
              traceId: `t${n}`,
              spanId: `s${n}`,
              workerQueue: "main",
              queue: "task/test-task",
              isTest: false,
              tags: [],
              ttl: "1s",
            },
            prisma
          )
        )
      );

      // Verify all runs are queued
      for (const run of runs) {
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("QUEUED");
      }

      // Wait for TTL to expire
      await setTimeout(1_500);

      // All runs should be expired
      expect(expiredEvents.length).toBe(3);

      for (const run of runs) {
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("FINISHED");
        expect(executionData.run.status).toBe("EXPIRED");
      }

      // Concurrency should be released for all
      const envConcurrency = await engine.runQueue.currentConcurrencyOfEnvironment(
        authenticatedEnvironment
      );
      expect(envConcurrency).toBe(0);
    } finally {
      await engine.quit();
    }
  });

  containerTest("Run without TTL does not expire", async ({ prisma, redisOptions }) => {
    const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const expiredEvents: EventBusEventArgs<"runExpired">[0][] = [];

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
        ttlSystem: {
          pollIntervalMs: 100,
          batchSize: 10,
        },
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

      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      engine.eventBus.on("runExpired", (result) => {
        expiredEvents.push(result);
      });

      // Trigger a run WITHOUT TTL
      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_n1234",
          environment: authenticatedEnvironment,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t1",
          spanId: "s1",
          workerQueue: "main",
          queue: "task/test-task",
          isTest: false,
          tags: [],
          // No TTL specified
        },
        prisma
      );

      // Wait a bit
      await setTimeout(500);

      // Run should still be queued, not expired
      expect(expiredEvents.length).toBe(0);

      const executionData = await engine.getRunExecutionData({ runId: run.id });
      assertNonNullable(executionData);
      expect(executionData.snapshot.executionStatus).toBe("QUEUED");
      expect(executionData.run.status).toBe("PENDING");
    } finally {
      await engine.quit();
    }
  });

  containerTest(
    "TTL consumer expires runs before they can be dequeued",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      const expiredEvents: EventBusEventArgs<"runExpired">[0][] = [];

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
          ttlSystem: {
            pollIntervalMs: 100,
            batchSize: 10,
          },
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

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        engine.eventBus.on("runExpired", (result) => {
          expiredEvents.push(result);
        });

        // Trigger a run with short TTL
        const expiredRun = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_e1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1",
            spanId: "s1",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            ttl: "1s", // Short TTL
          },
          prisma
        );

        // Wait for TTL to expire and TTL consumer to process it
        await setTimeout(1500);

        // The run should have been expired by the TTL consumer
        expect(expiredEvents.length).toBe(1);
        expect(expiredEvents[0]?.run.id).toBe(expiredRun.id);

        // The run should be in EXPIRED status
        const executionData = await engine.getRunExecutionData({ runId: expiredRun.id });
        assertNonNullable(executionData);
        expect(executionData.run.status).toBe("EXPIRED");
        expect(executionData.snapshot.executionStatus).toBe("FINISHED");

        // The run should have been removed from the queue by the TTL Lua script
        // So dequeue should return nothing
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test-consumer",
          workerQueue: "main",
          maxRunCount: 1,
          backgroundWorkerId: (
            await prisma.backgroundWorker.findFirst({
              where: { runtimeEnvironmentId: authenticatedEnvironment.id },
            })
          )!.id,
        });

        expect(dequeued.length).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "expireRunsBatch skips runs that are locked",
    async ({ prisma, redisOptions }) => {
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
          ttlSystem: {
            disabled: true, // We'll manually test the batch function
          },
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

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Trigger a run with TTL
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_l1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1",
            spanId: "s1",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            ttl: "1s",
          },
          prisma
        );

        // Manually lock the run (simulating it being about to execute)
        await prisma.taskRun.update({
          where: { id: run.id },
          data: { lockedAt: new Date() },
        });

        // Try to expire the run via batch
        const result = await engine.ttlSystem.expireRunsBatch([run.id]);

        // Should be skipped because it's locked
        expect(result.expired.length).toBe(0);
        expect(result.skipped.length).toBe(1);
        expect(result.skipped[0]?.reason).toBe("locked");

        // Run should still be PENDING
        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.run.status).toBe("PENDING");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "expireRunsBatch skips runs with non-PENDING status",
    async ({ prisma, redisOptions }) => {
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
          ttlSystem: {
            disabled: true,
          },
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

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Trigger a run with TTL
        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_x1234",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t1",
            spanId: "s1",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            ttl: "1s",
          },
          prisma
        );

        // Manually change status to EXECUTING (simulating the run started)
        await prisma.taskRun.update({
          where: { id: run.id },
          data: { status: "EXECUTING" },
        });

        // Try to expire the run via batch
        const result = await engine.ttlSystem.expireRunsBatch([run.id]);

        // Should be skipped because it's not PENDING
        expect(result.expired.length).toBe(0);
        expect(result.skipped.length).toBe(1);
        expect(result.skipped[0]?.reason).toBe("status_EXECUTING");

        // Run should still be EXECUTING
        const dbRun = await prisma.taskRun.findUnique({ where: { id: run.id } });
        expect(dbRun?.status).toBe("EXECUTING");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "expireRunsBatch handles non-existent runs",
    async ({ prisma, redisOptions }) => {
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
          ttlSystem: {
            disabled: true,
          },
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
        // Try to expire a non-existent run
        const result = await engine.ttlSystem.expireRunsBatch(["non_existent_run_id"]);

        // Should be skipped as not found
        expect(result.expired.length).toBe(0);
        expect(result.skipped.length).toBe(1);
        expect(result.skipped[0]?.reason).toBe("not_found");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "expireRunsBatch handles empty array",
    async ({ prisma, redisOptions }) => {
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
          ttlSystem: {
            disabled: true,
          },
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
        // Try to expire an empty array
        const result = await engine.ttlSystem.expireRunsBatch([]);

        expect(result.expired.length).toBe(0);
        expect(result.skipped.length).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );
});
