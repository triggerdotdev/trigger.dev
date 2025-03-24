import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "node:test";
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

describe("RunQueue.nackMessage", () => {
  redisTest("nacking a message clears all concurrency", async ({ redisContainer }) => {
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
      const envMasterQueue = `env:${authenticatedEnvDev.id}`;

      // Enqueue message with reserve concurrency
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageDev,
        masterQueues: ["main", envMasterQueue],
      });

      // Dequeue message
      const dequeued = await queue.dequeueMessageFromMasterQueue("test_12345", envMasterQueue, 10);
      expect(dequeued.length).toBe(1);

      // Verify current concurrency is set and reserve is cleared
      const queueCurrentConcurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        messageDev.queue
      );
      expect(queueCurrentConcurrency).toBe(1);

      const envCurrentConcurrency = await queue.currentConcurrencyOfEnvironment(
        authenticatedEnvDev
      );
      expect(envCurrentConcurrency).toBe(1);

      // Nack the message
      await queue.nackMessage({
        orgId: messageDev.orgId,
        messageId: messageDev.runId,
      });

      // Verify all concurrency is cleared
      const queueCurrentConcurrencyAfterNack = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        messageDev.queue
      );
      expect(queueCurrentConcurrencyAfterNack).toBe(0);

      const envCurrentConcurrencyAfterNack = await queue.currentConcurrencyOfEnvironment(
        authenticatedEnvDev
      );
      expect(envCurrentConcurrencyAfterNack).toBe(0);

      const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvDev);
      expect(envQueueLength).toBe(1);

      const message = await queue.readMessage(messageDev.orgId, messageDev.runId);
      expect(message?.attempt).toBe(1);

      //we need to wait because the default wait is 1 second
      await setTimeout(300);

      // Now we should be able to dequeue it again
      const dequeued2 = await queue.dequeueMessageFromMasterQueue("test_12345", envMasterQueue, 10);
      expect(dequeued2.length).toBe(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "nacking a message with maxAttempts reached should be moved to dead letter queue",
    async ({ redisContainer }) => {
      const queue = new RunQueue({
        ...testOptions,
        retryOptions: {
          ...testOptions.retryOptions,
          maxAttempts: 2, // Set lower for testing
        },
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
        const envMasterQueue = `env:${authenticatedEnvDev.id}`;

        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          masterQueues: ["main", envMasterQueue],
        });

        const dequeued = await queue.dequeueMessageFromMasterQueue(
          "test_12345",
          envMasterQueue,
          10
        );
        expect(dequeued.length).toBe(1);

        await queue.nackMessage({
          orgId: messageDev.orgId,
          messageId: messageDev.runId,
        });

        // Wait for any requeue delay
        await setTimeout(300);

        // Message should not be requeued as max attempts reached
        const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvDev);
        expect(envQueueLength).toBe(1);

        const message = await queue.readMessage(messageDev.orgId, messageDev.runId);
        expect(message?.attempt).toBe(1);

        // Now we dequeue and nack again, and it should be moved to dead letter queue
        const dequeued3 = await queue.dequeueMessageFromMasterQueue(
          "test_12345",
          envMasterQueue,
          10
        );
        expect(dequeued3.length).toBe(1);

        const envQueueLengthDequeue = await queue.lengthOfEnvQueue(authenticatedEnvDev);
        expect(envQueueLengthDequeue).toBe(0);

        const deadLetterQueueLengthBefore = await queue.lengthOfDeadLetterQueue(
          authenticatedEnvDev
        );
        expect(deadLetterQueueLengthBefore).toBe(0);

        await queue.nackMessage({
          orgId: messageDev.orgId,
          messageId: messageDev.runId,
        });

        const envQueueLengthAfterNack = await queue.lengthOfEnvQueue(authenticatedEnvDev);
        expect(envQueueLengthAfterNack).toBe(0);

        const deadLetterQueueLengthAfterNack = await queue.lengthOfDeadLetterQueue(
          authenticatedEnvDev
        );
        expect(deadLetterQueueLengthAfterNack).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );
});
