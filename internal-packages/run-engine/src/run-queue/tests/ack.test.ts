import { assertNonNullable, redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "node:test";
import { setTimeout } from "node:timers/promises";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import { InputPayload } from "../types.js";
import { Decimal } from "@trigger.dev/database";

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
  concurrencyLimitBurstFactor: new Decimal(2.0),
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

describe("RunQueue.acknowledgeMessage", () => {
  redisTest("acknowledging a message clears all concurrency", async ({ redisContainer }) => {
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
      // Enqueue and dequeue a message to get it into processing
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

      // Verify concurrency is set
      const queueConcurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        messageDev.queue
      );
      expect(queueConcurrency).toBe(1);

      const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
      expect(envConcurrency).toBe(1);

      // Acknowledge the message
      await queue.acknowledgeMessage(messageDev.orgId, messageDev.runId);

      // Verify all concurrency is cleared
      const queueConcurrencyAfter = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        messageDev.queue
      );
      expect(queueConcurrencyAfter).toBe(0);

      const envConcurrencyAfter = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
      expect(envConcurrencyAfter).toBe(0);
    } finally {
      await queue.quit();
    }
  });

  redisTest("acknowledging a message removes it from the queue", async ({ redisContainer }) => {
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

      // Verify queue lengths
      const queueLength = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
      expect(queueLength).toBe(1);

      const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvDev);
      expect(envQueueLength).toBe(1);

      await setTimeout(1000);

      // Dequeue the message
      const dequeued = await queue.dequeueMessageFromWorkerQueue(
        "test_12345",
        authenticatedEnvDev.id
      );
      assertNonNullable(dequeued);

      // Verify queue is empty after dequeue
      const queueLengthAfterDequeue = await queue.lengthOfQueue(
        authenticatedEnvDev,
        messageDev.queue
      );
      expect(queueLengthAfterDequeue).toBe(0);

      const envQueueLengthAfterDequeue = await queue.lengthOfEnvQueue(authenticatedEnvDev);
      expect(envQueueLengthAfterDequeue).toBe(0);

      // Acknowledge the message
      await queue.acknowledgeMessage(messageDev.orgId, messageDev.runId);

      // Verify queue remains empty
      const queueLengthAfterAck = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
      expect(queueLengthAfterAck).toBe(0);

      const envQueueLengthAfterAck = await queue.lengthOfEnvQueue(authenticatedEnvDev);
      expect(envQueueLengthAfterAck).toBe(0);
    } finally {
      await queue.quit();
    }
  });
});
