import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { RunEngine } from "../index.js";
import { PrismaClientOrTransaction } from "@trigger.dev/database";
import { MinimalAuthenticatedEnvironment } from "../../shared/index.js";
import { setTimeout } from "timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine priority", () => {
  containerTest(
    "runs execute in priority order based on priorityMs",
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

        //the order should be 4,3,1,0,2
        //                  0          1    2      3     4
        const priorities = [undefined, 500, -1200, 1000, 4000];

        //trigger the runs
        const runs = await triggerRuns({
          engine,
          environment: authenticatedEnvironment,
          taskIdentifier,
          prisma,
          runs: priorities.map((priority, index) => ({
            number: index,
            priorityMs: priority,
          })),
        });
        expect(runs.length).toBe(priorities.length);

        //check the queue length
        const queueLength = await engine.runQueue.lengthOfEnvQueue(authenticatedEnvironment);
        expect(queueLength).toBe(priorities.length);

        //dequeue (expect 4 items because of the negative priority)
        const dequeue = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: "main",
          maxRunCount: 20,
        });
        expect(dequeue.length).toBe(4);
        expect(dequeue[0].run.friendlyId).toBe(runs[4].friendlyId);
        expect(dequeue[1].run.friendlyId).toBe(runs[3].friendlyId);
        expect(dequeue[2].run.friendlyId).toBe(runs[1].friendlyId);
        expect(dequeue[3].run.friendlyId).toBe(runs[0].friendlyId);

        //wait 2 seconds (because of the negative priority)
        await setTimeout(2_000);
        const dequeue2 = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: "main",
          maxRunCount: 20,
        });
        expect(dequeue2.length).toBe(1);
        expect(dequeue2[0].run.friendlyId).toBe(runs[2].friendlyId);
      } finally {
        engine.quit();
      }
    }
  );

  containerTest(
    "runs execute in order of their queueTimestamp",
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

        //the order should be 2, 3, 1, 4, 0
        const queueTimestamps = [
          undefined,
          new Date(3000),
          new Date(1000),
          new Date(2000),
          new Date(4000),
        ];

        //trigger the runs
        const runs = await triggerRuns({
          engine,
          environment: authenticatedEnvironment,
          taskIdentifier,
          prisma,
          runs: queueTimestamps.map((queueTimestamp, index) => ({
            number: index,
            queueTimestamp,
          })),
        });
        expect(runs.length).toBe(queueTimestamps.length);

        //check the queue length
        const queueLength = await engine.runQueue.lengthOfEnvQueue(authenticatedEnvironment);
        expect(queueLength).toBe(queueTimestamps.length);

        //dequeue (expect 4 items because of the negative priority)
        const dequeue = await engine.dequeueFromMasterQueue({
          consumerId: "test_12345",
          masterQueue: "main",
          maxRunCount: 20,
        });
        expect(dequeue.length).toBe(queueTimestamps.length);
        expect(dequeue[0].run.friendlyId).toBe(runs[2].friendlyId);
        expect(dequeue[1].run.friendlyId).toBe(runs[3].friendlyId);
        expect(dequeue[2].run.friendlyId).toBe(runs[1].friendlyId);
        expect(dequeue[3].run.friendlyId).toBe(runs[4].friendlyId);
        expect(dequeue[4].run.friendlyId).toBe(runs[0].friendlyId);
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
  runs,
  prisma,
}: {
  engine: RunEngine;
  environment: MinimalAuthenticatedEnvironment;
  taskIdentifier: string;
  prisma: PrismaClientOrTransaction;
  runs: {
    number: number;
    priorityMs?: number;
    queueTimestamp?: Date;
  }[];
}) {
  const triggeredRuns = [];
  for (const run of runs) {
    triggeredRuns.push(
      await engine.trigger(
        {
          number: run.number,
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
          priorityMs: run.priorityMs,
          queueTimestamp: run.queueTimestamp,
        },
        prisma
      )
    );
  }

  return triggeredRuns;
}
