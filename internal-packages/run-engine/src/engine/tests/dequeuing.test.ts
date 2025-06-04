import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { DequeuedMessage } from "@trigger.dev/core/v3";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { PrismaClientOrTransaction } from "@trigger.dev/database";
import { expect } from "vitest";
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
