import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "node:test";
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

vi.setConfig({ testTimeout: 60_000 });

describe("RunQueue.dequeueMessageFromMasterQueue", () => {
  redisTest("dequeuing a message from a master queue", async ({ redisContainer }) => {
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
      //initial queue length
      const result = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
      expect(result).toBe(0);
      const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvDev);
      expect(envQueueLength).toBe(0);

      //initial oldest message
      const oldestScore = await queue.oldestMessageInQueue(authenticatedEnvDev, messageDev.queue);
      expect(oldestScore).toBe(undefined);

      const envMasterQueue = `env:${authenticatedEnvDev.id}`;

      //enqueue message
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageDev,
        masterQueues: ["main", envMasterQueue],
      });

      //queue length
      const result2 = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
      expect(result2).toBe(1);

      const envQueueLength2 = await queue.lengthOfEnvQueue(authenticatedEnvDev);
      expect(envQueueLength2).toBe(1);

      //oldest message
      const oldestScore2 = await queue.oldestMessageInQueue(authenticatedEnvDev, messageDev.queue);
      expect(oldestScore2).toBe(messageDev.timestamp);

      //concurrencies
      const queueConcurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        messageDev.queue
      );
      expect(queueConcurrency).toBe(0);

      const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
      expect(envConcurrency).toBe(0);

      const dequeued = await queue.dequeueMessageFromMasterQueue("test_12345", envMasterQueue, 10);
      expect(dequeued.length).toBe(1);
      expect(dequeued[0].messageId).toEqual(messageDev.runId);
      expect(dequeued[0].message.orgId).toEqual(messageDev.orgId);
      expect(dequeued[0].message.version).toEqual("1");
      expect(dequeued[0].message.masterQueues).toEqual(["main", envMasterQueue]);

      //concurrencies
      const queueConcurrencyAfter = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        messageDev.queue
      );
      expect(queueConcurrencyAfter).toBe(1);

      const envConcurrencyAfter = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
      expect(envConcurrencyAfter).toBe(1);

      //queue length
      const result3 = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
      expect(result3).toBe(0);
      const envQueueLength3 = await queue.lengthOfEnvQueue(authenticatedEnvDev);
      expect(envQueueLength3).toBe(0);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "should not dequeue when env current concurrency equals env concurrency limit",
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
        // Set env concurrency limit to 1
        await queue.updateEnvConcurrencyLimits({
          ...authenticatedEnvDev,
          maximumConcurrencyLimit: 1,
        });

        const envMasterQueue = `env:${authenticatedEnvDev.id}`;

        // Enqueue first message
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          masterQueues: ["main", envMasterQueue],
        });

        // Dequeue first message to occupy the concurrency
        const dequeued1 = await queue.dequeueMessageFromMasterQueue(
          "test_12345",
          envMasterQueue,
          10
        );
        expect(dequeued1.length).toBe(1);

        // Enqueue second message
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: { ...messageDev, runId: "r4322" },
          masterQueues: ["main", envMasterQueue],
        });

        // Try to dequeue second message
        const dequeued2 = await queue.dequeueMessageFromMasterQueue(
          "test_12345",
          envMasterQueue,
          10
        );
        expect(dequeued2.length).toBe(0);

        const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
        expect(envConcurrency).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "should respect queue concurrency limits when dequeuing",
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
        // Set queue concurrency limit to 1
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, messageDev.queue, 1);

        const envMasterQueue = `env:${authenticatedEnvDev.id}`;

        // Enqueue two messages
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          masterQueues: ["main", envMasterQueue],
        });

        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: { ...messageDev, runId: "r4322" },
          masterQueues: ["main", envMasterQueue],
        });

        // Dequeue first message
        const dequeued1 = await queue.dequeueMessageFromMasterQueue(
          "test_12345",
          envMasterQueue,
          10
        );
        expect(dequeued1.length).toBe(1);

        // Try to dequeue second message
        const dequeued2 = await queue.dequeueMessageFromMasterQueue(
          "test_12345",
          envMasterQueue,
          10
        );
        expect(dequeued2.length).toBe(0);

        const queueConcurrency = await queue.currentConcurrencyOfQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(queueConcurrency).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );
});
