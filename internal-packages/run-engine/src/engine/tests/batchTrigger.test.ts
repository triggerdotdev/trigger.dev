import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { TaskRunErrorCodes } from "@trigger.dev/core/v3";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "node:timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { DequeuedMessage } from "@trigger.dev/core/v3";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine batchTrigger", () => {
  containerTest("Batch trigger shares a batch", async ({ prisma, redisOptions }) => {
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
        baseCostInCents: 0.0005,
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

      const batch = await prisma.batchTaskRun.create({
        data: {
          friendlyId: generateFriendlyId("batch"),
          runtimeEnvironmentId: authenticatedEnvironment.id,
        },
      });

      //trigger the runs
      const run1 = await engine.trigger(
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
          batch: { id: batch.id, index: 0 },
        },
        prisma
      );

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
          traceId: "t12345",
          spanId: "s12345",
          workerQueue: "main",
          queue: "task/test-task",
          isTest: false,
          tags: [],
          batch: { id: batch.id, index: 1 },
        },
        prisma
      );

      expect(run1).toBeDefined();
      expect(run1.friendlyId).toBe("run_1234");
      expect(run1.batchId).toBe(batch.id);

      expect(run2).toBeDefined();
      expect(run2.friendlyId).toBe("run_1235");
      expect(run2.batchId).toBe(batch.id);

      //check the queue length
      const queueLength = await engine.runQueue.lengthOfEnvQueue(authenticatedEnvironment);
      expect(queueLength).toBe(2);

      //dequeue
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
      const [d1, d2] = dequeued;
      //attempts
      const attempt1 = await engine.startRunAttempt({
        runId: d1.run.id,
        snapshotId: d1.snapshot.id,
      });
      const attempt2 = await engine.startRunAttempt({
        runId: d2.run.id,
        snapshotId: d2.snapshot.id,
      });

      //complete the runs
      const result1 = await engine.completeRunAttempt({
        runId: attempt1.run.id,
        snapshotId: attempt1.snapshot.id,
        completion: {
          ok: true,
          id: attempt1.run.id,
          output: `{"foo":"bar"}`,
          outputType: "application/json",
        },
      });
      const result2 = await engine.completeRunAttempt({
        runId: attempt2.run.id,
        snapshotId: attempt2.snapshot.id,
        completion: {
          ok: true,
          id: attempt2.run.id,
          output: `{"baz":"qux"}`,
          outputType: "application/json",
        },
      });

      //the batch won't complete immediately
      const batchAfter1 = await prisma.batchTaskRun.findUnique({
        where: {
          id: batch.id,
        },
      });
      expect(batchAfter1?.status).toBe("PENDING");

      await setTimeout(3_000);

      //the batch should complete
      const batchAfter2 = await prisma.batchTaskRun.findUnique({
        where: {
          id: batch.id,
        },
      });
      expect(batchAfter2?.status).toBe("COMPLETED");
    } finally {
      await engine.quit();
    }
  });

  containerTest(
    "Batch completes when one run is triggered and one is pre-failed (simulates per-item trigger failure)",
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
          baseCostInCents: 0.0005,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const batch = await prisma.batchTaskRun.create({
          data: {
            friendlyId: generateFriendlyId("batch"),
            runtimeEnvironmentId: authenticatedEnvironment.id,
            runCount: 2,
            processingJobsCount: 2,
            batchVersion: "runengine:v1",
          },
        });

        const triggeredRun = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_batchok1",
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
            batch: { id: batch.id, index: 0 },
          },
          prisma
        );
        expect(triggeredRun).toBeDefined();
        expect(triggeredRun.batchId).toBe(batch.id);

        const preFailedRunFriendlyId = generateFriendlyId("run");
        const preFailedRun = await engine.createFailedTaskRun({
          friendlyId: preFailedRunFriendlyId,
          environment: {
            id: authenticatedEnvironment.id,
            type: authenticatedEnvironment.type,
            project: { id: authenticatedEnvironment.project.id },
            organization: { id: authenticatedEnvironment.organization.id },
          },
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          error: {
            type: "INTERNAL_ERROR",
            code: TaskRunErrorCodes.BATCH_ITEM_COULD_NOT_TRIGGER,
            message: "Queue size limit exceeded",
          },
          batch: { id: batch.id, index: 1 },
        });
        expect(preFailedRun).toBeDefined();
        expect(preFailedRun.friendlyId).toBe(preFailedRunFriendlyId);
        expect(preFailedRun.status).toBe("SYSTEM_FAILURE");
        expect(preFailedRun.batchId).toBe(batch.id);

        const queueLength = await engine.runQueue.lengthOfEnvQueue(authenticatedEnvironment);
        expect(queueLength).toBe(1);

        await setTimeout(500);
        const [dequeued] = await engine.dequeueFromWorkerQueue({
          consumerId: "test_consumer",
          workerQueue: "main",
        });
        expect(dequeued).toBeDefined();
        const attempt = await engine.startRunAttempt({
          runId: dequeued.run.id,
          snapshotId: dequeued.snapshot.id,
        });
        await engine.completeRunAttempt({
          runId: attempt.run.id,
          snapshotId: attempt.snapshot.id,
          completion: {
            ok: true,
            id: attempt.run.id,
            output: `{"done":true}`,
            outputType: "application/json",
          },
        });

        await engine.tryCompleteBatch({ batchId: batch.id });
        await setTimeout(3_000);

        const batchAfter = await prisma.batchTaskRun.findUnique({
          where: { id: batch.id },
        });
        expect(batchAfter?.status).toBe("COMPLETED");

        const runs = await prisma.taskRun.findMany({
          where: { batchId: batch.id },
          orderBy: { createdAt: "asc" },
        });
        expect(runs).toHaveLength(2);
        expect(runs[0].status).toBe("COMPLETED_SUCCESSFULLY");
        expect(runs[1].status).toBe("SYSTEM_FAILURE");
        expect(runs[1].friendlyId).toBe(preFailedRunFriendlyId);
      } finally {
        await engine.quit();
      }
    }
  );
});
