import { assertNonNullable, redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import { InputPayload } from "../types.js";
import { setTimeout } from "node:timers/promises";

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  workers: 1,
  defaultEnvConcurrency: 25,
  enableRebalancing: false,
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

const authenticatedEnvProd = {
  id: "e1234",
  type: "PRODUCTION" as const,
  maximumConcurrencyLimit: 10,
  project: { id: "p1234" },
  organization: { id: "o1234" },
};

const messageProd: InputPayload = {
  runId: "r1234",
  taskIdentifier: "task/my-task",
  orgId: "o1234",
  projectId: "p1234",
  environmentId: "e1234",
  environmentType: "PRODUCTION",
  queue: "task/my-task",
  timestamp: Date.now(),
  attempt: 0,
};

describe("RunQueue.releaseConcurrency", () => {
  redisTest(
    "It should release the concurrency on the queue and the env",
    async ({ redisContainer }) => {
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
      });

      try {
        await queue.enqueueMessage({
          env: authenticatedEnvProd,
          message: messageProd,
          workerQueue: authenticatedEnvProd.id,
        });

        await setTimeout(1000);

        const message = await queue.dequeueMessageFromWorkerQueue(
          "test_12345",
          authenticatedEnvProd.id
        );
        assertNonNullable(message);

        //concurrencies
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
          1
        );
        expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);

        //release the concurrency
        await queue.releaseAllConcurrency(authenticatedEnvProd.organization.id, messageProd.runId);

        //concurrencies
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
          0
        );
        expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "it shouldn't affect the current concurrency if the run hasn't been dequeued",
    async ({ redisContainer }) => {
      const queue = new RunQueue({
        ...testOptions,
        masterQueueConsumersDisabled: true,
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
      });

      try {
        await queue.enqueueMessage({
          env: authenticatedEnvProd,
          message: messageProd,
          workerQueue: authenticatedEnvProd.id,
          skipDequeueProcessing: true,
        });

        await queue.enqueueMessage({
          env: authenticatedEnvProd,
          message: { ...messageProd, runId: "r1235" },
          workerQueue: authenticatedEnvProd.id,
          skipDequeueProcessing: true,
        });

        // Only process one message
        await queue.processMasterQueueForEnvironment(authenticatedEnvProd.id, 1);

        const message = await queue.dequeueMessageFromWorkerQueue(
          "test_12345",
          authenticatedEnvProd.id
        );
        assertNonNullable(message);

        //concurrencies
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
          1
        );
        expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);

        //release the concurrency
        await queue.releaseAllConcurrency(authenticatedEnvProd.organization.id, "r1235");

        //concurrencies
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
          1
        );
        expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );
});
