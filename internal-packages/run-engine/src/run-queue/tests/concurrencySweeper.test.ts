import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "node:test";
import { setTimeout } from "node:timers/promises";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import { InputPayload } from "../types.js";

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 25,
  logger: new Logger("RunQueue", "warn"),
  retryOptions: {
    maxAttempts: 5,
    factor: 1.1,
    minTimeoutInMs: 100,
    maxTimeoutInMs: 1_000,
    randomize: true,
  },
  keys: new RunQueueFullKeyProducer(),
};

const authenticatedEnvDev = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
  maximumConcurrencyLimit: 10,
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

const messageDev: InputPayload = {
  runId: "r4321",
  taskIdentifier: "task/my-task",
  orgId: "o1234",
  projectId: "p1234",
  environmentId: "e4321",
  environmentType: "DEVELOPMENT",
  queue: "task/my-task",
  timestamp: Date.now(),
  attempt: 0,
};

const messageDev2: InputPayload = {
  ...messageDev,
  runId: "r4322",
};

vi.setConfig({ testTimeout: 60_000 });

describe("RunQueue Concurrency Sweeper", () => {
  redisTest(
    "should process queue current concurrency sets and mark runs for ack if they are completed",
    async ({ redisContainer }) => {
      let enableConcurrencySweeper = false;

      const queue = new RunQueue({
        ...testOptions,
        queueSelectionStrategy: new FairQueueSelectionStrategy({
          redis: {
            keyPrefix: "runqueue:test:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
          keys: testOptions.keys,
        }),
        redis: {
          keyPrefix: "runqueue:test:",
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
        },
        concurrencySweeper: {
          enabled: true,
          logLevel: "debug",
          scanIntervalMs: 500,
          processMarkedIntervalMs: 100,
          callback: async (runIds) => {
            if (!enableConcurrencySweeper) {
              return [];
            }

            return [{ id: messageDev.runId, orgId: "o1234" }];
          },
        },
      });

      try {
        //enqueue message
        const enqueueResult = await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          workerQueue: authenticatedEnvDev.id,
        });

        expect(enqueueResult).toBe(undefined);

        const enqueueResult2 = await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev2,
          workerQueue: authenticatedEnvDev.id,
        });

        expect(enqueueResult2).toBe(undefined);

        //queue length
        const result2 = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
        expect(result2).toBe(2);

        const envQueueLength2 = await queue.lengthOfEnvQueue(authenticatedEnvDev);
        expect(envQueueLength2).toBe(2);

        //concurrencies
        const queueConcurrency = await queue.currentConcurrencyOfQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(queueConcurrency).toBe(0);

        const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
        expect(envConcurrency).toBe(0);

        //dequeue message
        const dequeued = await queue.dequeueMessageFromWorkerQueue(
          "test_12345",
          authenticatedEnvDev.id
        );

        expect(dequeued).toBeDefined();
        expect(dequeued?.messageId).toEqual(messageDev.runId);

        const dequeued2 = await queue.dequeueMessageFromWorkerQueue(
          "test_12345",
          authenticatedEnvDev.id
        );
        expect(dequeued2).toBeDefined();
        expect(dequeued2?.messageId).toEqual(messageDev2.runId);

        // queue concurrency should be 2
        const queueConcurrency2 = await queue.currentConcurrencyOfQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(queueConcurrency2).toBe(2);

        // env concurrency should be 2
        const envConcurrency2 = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
        expect(envConcurrency2).toBe(2);

        enableConcurrencySweeper = true;

        await setTimeout(1000); // Now a run is "completed" and should be removed from the concurrency set

        // queue concurrency should be 0
        const queueConcurrency3 = await queue.currentConcurrencyOfQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(queueConcurrency3).toBe(1);

        // env concurrency should be 1
        const envConcurrency3 = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
        expect(envConcurrency3).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );
});
