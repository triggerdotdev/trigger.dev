import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { PrismaClientOrTransaction } from "@trigger.dev/database";
import { expect } from "vitest";
import { MinimalAuthenticatedEnvironment } from "../../shared/index.js";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { DequeuedMessage } from "@trigger.dev/core/v3";

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

      //check the queue length
      const queueLength = await engine.runQueue.lengthOfEnvQueue(authenticatedEnvironment);
      expect(queueLength).toBe(10);

      //dequeue
      const dequeued: DequeuedMessage[] = [];
      for (let i = 0; i < 5; i++) {
        dequeued.push(
          ...(await engine.dequeueFromMasterQueue({
            consumerId: "test_12345",
            masterQueue: "main",
            maxRunCount: 1,
          }))
        );
      }

      expect(dequeued.length).toBe(5);
    } finally {
      engine.quit();
    }
  });

  //This will fail until we support dequeuing multiple runs from a single environment
  containerTest.fails(
    "Dequeues runs within machine constraints",
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
        await setupBackgroundWorker(engine, authenticatedEnvironment, taskIdentifier, {
          preset: "small-1x",
        });

        //trigger the runs
        const runs = await triggerRuns({
          engine,
          environment: authenticatedEnvironment,
          taskIdentifier,
          prisma,
          count: 20,
        });
        expect(runs.length).toBe(20);

        //check the queue length
        const queueLength = await engine.runQueue.lengthOfEnvQueue(authenticatedEnvironment);
        expect(queueLength).toBe(20);

        //dequeue
        const dequeued = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: "main",
          maxRunCount: 5,
          maxResources: {
            cpu: 1.1,
            memory: 3.8,
          },
        });
        expect(dequeued.length).toBe(2);

        //check the queue length
        const queueLength2 = await engine.runQueue.lengthOfEnvQueue(authenticatedEnvironment);
        expect(queueLength2).toBe(18);

        const dequeued2 = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: "main",
          maxRunCount: 10,
          maxResources: {
            cpu: 4.7,
            memory: 3.0,
          },
        });
        expect(dequeued2.length).toBe(6);

        //check the queue length
        const queueLength3 = await engine.runQueue.lengthOfEnvQueue(authenticatedEnvironment);
        expect(queueLength3).toBe(12);
      } finally {
        engine.quit();
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
        masterQueue: "main",
        queue: `task/${taskIdentifier}`,
        isTest: false,
        tags: [],
      },
      prisma
    );
  }

  return runs;
}
