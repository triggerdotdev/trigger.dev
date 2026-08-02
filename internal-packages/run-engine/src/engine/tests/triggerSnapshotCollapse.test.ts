import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { PrismaClient, TaskRunExecutionStatus } from "@trigger.dev/database";
import { setTimeout } from "node:timers/promises";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

async function snapshotStatuses(
  prisma: PrismaClient,
  runId: string
): Promise<TaskRunExecutionStatus[]> {
  const snapshots = await prisma.taskRunExecutionSnapshot.findMany({
    where: { runId },
    orderBy: { createdAt: "asc" },
    select: { executionStatus: true },
  });

  return snapshots.map((snapshot) => snapshot.executionStatus);
}

describe("RunEngine trigger() execution snapshots", () => {
  containerTest(
    "a non-delayed run is created with a single QUEUED snapshot",
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
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

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
            traceId: "t_collapse_1",
            spanId: "s_collapse_1",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        expect(await snapshotStatuses(prisma, run.id)).toEqual(["QUEUED"]);

        const queueLength = await engine.runQueue.lengthOfQueue(
          authenticatedEnvironment,
          run.queue
        );
        expect(queueLength).toBe(1);

        const executionData = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionData);
        expect(executionData.snapshot.executionStatus).toBe("QUEUED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "the QUEUED snapshot event is stamped at write time, not at an overridden run createdAt",
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
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const stampedTimes: Date[] = [];
        engine.eventBus.on("executionSnapshotCreated", ({ time }) => {
          stampedTimes.push(time);
        });

        const backdatedCreatedAt = new Date(Date.now() - 60 * 60 * 1000);
        const triggeredAt = Date.now();

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1236",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_collapse_3",
            spanId: "s_collapse_3",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            createdAt: backdatedCreatedAt,
          },
          prisma
        );

        const storedRun = await prisma.taskRun.findUnique({ where: { id: run.id } });
        expect(storedRun?.createdAt.getTime()).toBe(backdatedCreatedAt.getTime());

        expect(stampedTimes.length).toBe(1);
        expect(stampedTimes[0].getTime()).toBeGreaterThanOrEqual(triggeredAt);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a delayed run keeps DELAYED and QUEUED as separate snapshots",
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
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1235",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_collapse_2",
            spanId: "s_collapse_2",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
            delayUntil: new Date(Date.now() + 500),
          },
          prisma
        );

        expect(await snapshotStatuses(prisma, run.id)).toEqual(["DELAYED"]);

        await setTimeout(1_500);

        expect(await snapshotStatuses(prisma, run.id)).toEqual(["DELAYED", "QUEUED"]);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a resumed run still writes its own QUEUED snapshot",
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
          baseCostInCents: 0.0001,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_1237",
            environment: authenticatedEnvironment,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t_collapse_4",
            spanId: "s_collapse_4",
            workerQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        await setTimeout(500);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_collapse_4",
          workerQueue: "main",
        });
        assertNonNullable(dequeued[0]);

        await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        const waitpointResult = await engine.createManualWaitpoint({
          environmentId: authenticatedEnvironment.id,
          projectId: authenticatedEnvironment.projectId,
        });

        const blockedResult = await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpointResult.waitpoint.id,
          projectId: authenticatedEnvironment.projectId,
          organizationId: authenticatedEnvironment.organizationId,
        });

        const checkpointResult = await engine.createCheckpoint({
          runId: run.id,
          snapshotId: blockedResult.id,
          checkpoint: {
            type: "DOCKER",
            reason: "TEST_CHECKPOINT",
            location: "test-location",
            imageRef: "test-image-ref",
          },
        });
        expect(checkpointResult.ok).toBe(true);

        await engine.completeWaitpoint({ id: waitpointResult.waitpoint.id });
        await setTimeout(500);

        expect(await snapshotStatuses(prisma, run.id)).toEqual([
          "QUEUED",
          "PENDING_EXECUTING",
          "EXECUTING",
          "EXECUTING_WITH_WAITPOINTS",
          "SUSPENDED",
          "QUEUED",
        ]);
      } finally {
        await engine.quit();
      }
    }
  );
});
