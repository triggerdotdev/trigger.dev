import { assertNonNullable, redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
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
      // Enqueue message with reserve concurrency
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageDev,
        workerQueue: authenticatedEnvDev.id,
      });

      await setTimeout(1000);

      // Dequeue message
      const dequeued = await queue.dequeueMessageFromWorkerQueue(
        "test_12345",
        authenticatedEnvDev.id
      );
      assertNonNullable(dequeued);

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
      await setTimeout(1000);

      // Now we should be able to dequeue it again
      const dequeued2 = await queue.dequeueMessageFromWorkerQueue(
        "test_12345",
        authenticatedEnvDev.id
      );
      assertNonNullable(dequeued2);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "nacking a message with maxAttempts reached should be moved to dead letter queue",
    async ({ redisContainer }) => {
      const queue = new RunQueue({
        ...testOptions,
        logLevel: "debug",
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
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          workerQueue: authenticatedEnvDev.id,
        });

        await setTimeout(1000);

        const dequeued = await queue.dequeueMessageFromWorkerQueue(
          "test_12345",
          authenticatedEnvDev.id
        );
        assertNonNullable(dequeued);

        await queue.nackMessage({
          orgId: messageDev.orgId,
          messageId: messageDev.runId,
        });

        // Message should not be requeued as max attempts reached
        const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvDev);
        expect(envQueueLength).toBe(1);

        const message = await queue.readMessage(messageDev.orgId, messageDev.runId);
        expect(message?.attempt).toBe(1);

        await setTimeout(1000);

        // Now we dequeue and nack again, and it should be moved to dead letter queue
        const dequeued3 = await queue.dequeueMessageFromWorkerQueue(
          "test_12345",
          authenticatedEnvDev.id
        );
        assertNonNullable(dequeued3);

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

  redisTest(
    "nacking a message with retryAt sets the correct requeue time",
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
        // Enqueue message
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          workerQueue: authenticatedEnvDev.id,
        });

        await setTimeout(1000);

        // Dequeue message
        const dequeued = await queue.dequeueMessageFromWorkerQueue(
          "test_12345",
          authenticatedEnvDev.id
        );
        assertNonNullable(dequeued);

        // Set retryAt to 5 seconds in the future
        const retryAt = Date.now() + 5000;
        await queue.nackMessage({
          orgId: messageDev.orgId,
          messageId: messageDev.runId,
          retryAt,
        });

        // Check the score of the message in the queue
        const queueKey = queue.keys.queueKey(authenticatedEnvDev, messageDev.queue);
        const score = await queue.oldestMessageInQueue(authenticatedEnvDev, messageDev.queue);
        expect(typeof score).toBe("number");
        if (typeof score !== "number") {
          throw new Error("Expected score to be a number, but got undefined");
        }
        // Should be within 100ms of retryAt
        expect(Math.abs(score - retryAt)).toBeLessThanOrEqual(100);
      } finally {
        await queue.quit();
      }
    }
  );
});
