import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { DequeuedMessage } from "@trigger.dev/core/v3";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { PrismaClientOrTransaction } from "@trigger.dev/database";
import { expect } from "vitest";
import { setTimeout } from "node:timers/promises";
import { MinimalAuthenticatedEnvironment } from "../../shared/index.js";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine dequeuing", () => {
  containerTest("Dequeues 5 runs", async ({ prisma, redisOptions }) => {
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
      await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

      //trigger the runs
      const runs = await triggerRuns({
        engine,
        environment: authenticatedEnvironment,
        taskIdentifier,
        prisma,
        count: 10,
      });
      expect(runs.length).toBe(10);

      //dequeue
      await engine.runQueue.processMasterQueueForEnvironment(authenticatedEnvironment.id, 5);

      const dequeued: DequeuedMessage[] = [];
      for (let i = 0; i < 5; i++) {
        dequeued.push(
          ...(await engine.dequeueFromWorkerQueue({
            consumerId: "test_12345",
            workerQueue: "main",
          }))
        );
      }

      expect(dequeued.length).toBe(5);
    } finally {
      await engine.quit();
    }
  });

  containerTest(
    "Direct nack after dequeue clears concurrency and allows recovery",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // Use a short heartbeat timeout so the stalled system recovers the run quickly
      const pendingExecutingTimeout = 1000;

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
        heartbeatTimeoutsMs: {
          PENDING_EXECUTING: pendingExecutingTimeout,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      try {
        const taskIdentifier = "test-task";

        // Setup background worker
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier);

        // Trigger a single run
        const runs = await triggerRuns({
          engine,
          environment: authenticatedEnvironment,
          taskIdentifier,
          prisma,
          count: 1,
        });
        expect(runs.length).toBe(1);
        const run = runs[0];

        // Process master queue to move run to worker queue
        await engine.runQueue.processMasterQueueForEnvironment(authenticatedEnvironment.id, 1);

        // Wait for processing
        await setTimeout(500);

        // Dequeue from worker queue - this puts run in concurrency sets and creates PENDING_EXECUTING snapshot
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(1);
        assertNonNullable(dequeued[0]);

        // Verify run is in PENDING_EXECUTING state
        const executionDataBefore = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionDataBefore);
        expect(executionDataBefore.snapshot.executionStatus).toBe("PENDING_EXECUTING");

        // Verify run is in concurrency
        const envConcurrencyBefore = await engine.runQueue.currentConcurrencyOfEnvironment(
          authenticatedEnvironment
        );
        expect(envConcurrencyBefore).toBe(1);

        // Simulate DB failure fallback: call nackMessage directly via Redis
        // This is what happens when the catch block can't read from Postgres
        await engine.runQueue.nackMessage({
          orgId: authenticatedEnvironment.organization.id,
          messageId: run.id,
        });

        // Verify concurrency is cleared - this is the key fix!
        // Without this fix, the run would stay in concurrency sets forever
        const envConcurrencyAfter = await engine.runQueue.currentConcurrencyOfEnvironment(
          authenticatedEnvironment
        );
        expect(envConcurrencyAfter).toBe(0);

        // Verify the message is back in the queue
        const envQueueLength = await engine.runQueue.lengthOfEnvQueue(authenticatedEnvironment);
        expect(envQueueLength).toBe(1);

        // Wait for the stalled system to detect and recover the PENDING_EXECUTING run
        // The stalled system will call tryNackAndRequeue which updates Postgres state to QUEUED
        await setTimeout(pendingExecutingTimeout * 5);

        // Verify the stalled system recovered the run to QUEUED state
        const executionDataAfterStall = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executionDataAfterStall);
        expect(executionDataAfterStall.snapshot.executionStatus).toBe("QUEUED");

        // Process master queue to move the run from env queue to worker queue
        await engine.runQueue.processMasterQueueForEnvironment(authenticatedEnvironment.id, 1);

        // Wait for processing
        await setTimeout(500);

        // Dequeue from worker queue - the run should now be available
        const dequeuedAgain = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        expect(dequeuedAgain.length).toBe(1);
        assertNonNullable(dequeuedAgain[0]);
        expect(dequeuedAgain[0].run.id).toBe(run.id);
      } finally {
        await engine.quit();
      }
    }
  );
});

async function triggerRuns({
  engine,
  environment,
  taskIdentifier,
  prisma,
  count,
}: {
  engine: RunEngine;
  environment: MinimalAuthenticatedEnvironment;
  taskIdentifier: string;
  prisma: PrismaClientOrTransaction;
  count: number;
}) {
  const runs = [];
  for (let i = 0; i < count; i++) {
    runs[i] = await engine.trigger(
      {
        number: i,
        friendlyId: generateFriendlyId("run"),
        environment,
        taskIdentifier,
        payload: "{}",
        payloadType: "application/json",
        context: {},
        traceContext: {},
        traceId: "t12345",
        spanId: "s12345",
        workerQueue: "main",
        queue: `task/${taskIdentifier}`,
        isTest: false,
        tags: [],
      },
      prisma
    );
  }

  return runs;
}
