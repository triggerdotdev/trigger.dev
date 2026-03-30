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

function createQueue(redisContainer: { getHost: () => string; getPort: () => number }, prefix = "runqueue:test:") {
  return new RunQueue({
    ...testOptions,
    queueSelectionStrategy: new FairQueueSelectionStrategy({
      redis: {
        keyPrefix: prefix,
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
      keys: testOptions.keys,
    }),
    redis: {
      keyPrefix: prefix,
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
    },
  });
}

describe("RunQueue.enqueueMessage", () => {
  redisTest("should add the message to the queue", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer);

    try {
      //initial queue length
      const result = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
      expect(result).toBe(0);
      const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvDev);
      expect(envQueueLength).toBe(0);

      //initial oldest message
      const oldestScore = await queue.oldestMessageInQueue(authenticatedEnvDev, messageDev.queue);
      expect(oldestScore).toBe(undefined);

      //enqueue message
      const enqueueResult = await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageDev,
        workerQueue: authenticatedEnvDev.id,
      });

      expect(enqueueResult).toBe(undefined);

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

      await setTimeout(1000);

      //dequeue message
      const dequeued = await queue.dequeueMessageFromWorkerQueue(
        "test_12345",
        authenticatedEnvDev.id
      );
      assertNonNullable(dequeued);
      expect(dequeued.messageId).toEqual(messageDev.runId);
      expect(dequeued.message.orgId).toEqual(messageDev.orgId);
      expect(dequeued.message.version).toEqual("2");
      const workerQueue =
        dequeued.message.version == "2" ? dequeued.message.workerQueue : undefined;
      expect(workerQueue).toEqual(authenticatedEnvDev.id);
    } finally {
      await queue.quit();
    }
  });
});

describe("RunQueue.enqueueMessage fast path", () => {
  redisTest("should fast-path to worker queue when queue is empty and concurrency available", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, "runqueue:fp1:");

    try {
      // Set concurrency limits
      await queue.updateEnvConcurrencyLimits(authenticatedEnvDev);

      // Enqueue with fast path enabled
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageDev,
        workerQueue: authenticatedEnvDev.id,
        enableFastPath: true,
      });

      // Queue sorted set should be empty (fast path skips it)
      const queueLength = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
      expect(queueLength).toBe(0);

      // Queue concurrency should be claimed (operational concurrency)
      const queueConcurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        messageDev.queue
      );
      expect(queueConcurrency).toBe(1);

      // Message should be directly in worker queue - dequeue it
      const dequeued = await queue.dequeueMessageFromWorkerQueue(
        "test_12345",
        authenticatedEnvDev.id,
        { blockingPop: false }
      );
      assertNonNullable(dequeued);
      expect(dequeued.messageId).toEqual(messageDev.runId);
      expect(dequeued.message.version).toEqual("2");
    } finally {
      await queue.quit();
    }
  });

  redisTest("should take slow path when enableFastPath is false", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, "runqueue:fp2:");

    try {
      await queue.updateEnvConcurrencyLimits(authenticatedEnvDev);

      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageDev,
        workerQueue: authenticatedEnvDev.id,
        enableFastPath: false,
      });

      // Message should be in the queue sorted set (slow path)
      const queueLength = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
      expect(queueLength).toBe(1);

      // No concurrency claimed yet
      const queueConcurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        messageDev.queue
      );
      expect(queueConcurrency).toBe(0);
    } finally {
      await queue.quit();
    }
  });

  redisTest("should take slow path when queue has available messages", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, "runqueue:fp3:");

    try {
      await queue.updateEnvConcurrencyLimits(authenticatedEnvDev);

      // Enqueue a first message (slow path to populate the queue)
      const message1: InputPayload = {
        ...messageDev,
        runId: "r1111",
        timestamp: Date.now() - 1000, // in the past, so it's "available"
      };
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: message1,
        workerQueue: authenticatedEnvDev.id,
        enableFastPath: false,
      });

      // Now enqueue a second message with fast path
      const message2: InputPayload = {
        ...messageDev,
        runId: "r2222",
        timestamp: Date.now(),
      };
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: message2,
        workerQueue: authenticatedEnvDev.id,
        enableFastPath: true,
      });

      // Both messages should be in the queue sorted set (slow path for both)
      const queueLength = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
      expect(queueLength).toBe(2);
    } finally {
      await queue.quit();
    }
  });

  redisTest("should fast-path when queue only has future-scored messages", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, "runqueue:fp4:");

    try {
      await queue.updateEnvConcurrencyLimits(authenticatedEnvDev);

      // Enqueue a message with a future timestamp (simulating a nacked retry)
      const futureMessage: InputPayload = {
        ...messageDev,
        runId: "r_future",
        timestamp: Date.now() + 60_000, // 60 seconds in the future
      };
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: futureMessage,
        workerQueue: authenticatedEnvDev.id,
        enableFastPath: false,
      });

      // Queue has 1 message but it's not available (future score)
      const queueLength = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
      expect(queueLength).toBe(1);

      // Now enqueue a new message with fast path
      const newMessage: InputPayload = {
        ...messageDev,
        runId: "r_new",
        timestamp: Date.now(),
      };
      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: newMessage,
        workerQueue: authenticatedEnvDev.id,
        enableFastPath: true,
      });

      // The future message stays in queue, new message went to worker queue
      const queueLength2 = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
      expect(queueLength2).toBe(1); // Only the future message

      // Queue concurrency claimed for the fast-pathed message
      const queueConcurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        messageDev.queue
      );
      expect(queueConcurrency).toBe(1);

      // Can dequeue the fast-pathed message from worker queue
      const dequeued = await queue.dequeueMessageFromWorkerQueue(
        "test_12345",
        authenticatedEnvDev.id,
        { blockingPop: false }
      );
      assertNonNullable(dequeued);
      expect(dequeued.messageId).toEqual("r_new");
    } finally {
      await queue.quit();
    }
  });

  redisTest("should take slow path when env concurrency is full", async ({ redisContainer }) => {
    // Use a low concurrency limit
    const lowConcurrencyEnv = {
      ...authenticatedEnvDev,
      maximumConcurrencyLimit: 1,
      concurrencyLimitBurstFactor: new Decimal(1.0),
    };

    const queue = createQueue(redisContainer, "runqueue:fp5:");

    try {
      await queue.updateEnvConcurrencyLimits(lowConcurrencyEnv);

      // First message takes fast path
      const message1: InputPayload = {
        ...messageDev,
        runId: "r_first",
        timestamp: Date.now(),
      };
      await queue.enqueueMessage({
        env: lowConcurrencyEnv,
        message: message1,
        workerQueue: lowConcurrencyEnv.id,
        enableFastPath: true,
      });

      // Queue concurrency is now 1 (fast path claimed it)
      const queueConcurrency = await queue.currentConcurrencyOfQueue(
        lowConcurrencyEnv,
        messageDev.queue
      );
      expect(queueConcurrency).toBe(1);

      // Second message should take slow path (env concurrency full)
      const message2: InputPayload = {
        ...messageDev,
        runId: "r_second",
        timestamp: Date.now(),
      };
      await queue.enqueueMessage({
        env: lowConcurrencyEnv,
        message: message2,
        workerQueue: lowConcurrencyEnv.id,
        enableFastPath: true,
      });

      // Second message should be in queue sorted set
      const queueLength = await queue.lengthOfQueue(lowConcurrencyEnv, messageDev.queue);
      expect(queueLength).toBe(1);

      // Queue concurrency unchanged (still 1 from first message)
      const queueConcurrency2 = await queue.currentConcurrencyOfQueue(
        lowConcurrencyEnv,
        messageDev.queue
      );
      expect(queueConcurrency2).toBe(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest("fast-path message can be acknowledged correctly", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, "runqueue:fp6:");

    try {
      await queue.updateEnvConcurrencyLimits(authenticatedEnvDev);

      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageDev,
        workerQueue: authenticatedEnvDev.id,
        enableFastPath: true,
      });

      // Verify fast path was taken
      const queueConcurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        messageDev.queue
      );
      expect(queueConcurrency).toBe(1);

      // Dequeue from worker queue
      const dequeued = await queue.dequeueMessageFromWorkerQueue(
        "test_12345",
        authenticatedEnvDev.id,
        { blockingPop: false }
      );
      assertNonNullable(dequeued);

      // Acknowledge the message
      await queue.acknowledgeMessage(messageDev.orgId, dequeued.messageId);

      // Queue concurrency should be released
      const queueConcurrencyAfter = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        messageDev.queue
      );
      expect(queueConcurrencyAfter).toBe(0);
    } finally {
      await queue.quit();
    }
  });

  redisTest("fast-path message can be nacked and re-enqueued", async ({ redisContainer }) => {
    const queue = createQueue(redisContainer, "runqueue:fp7:");

    try {
      await queue.updateEnvConcurrencyLimits(authenticatedEnvDev);

      await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageDev,
        workerQueue: authenticatedEnvDev.id,
        enableFastPath: true,
      });

      // Verify fast path was taken
      const queueConcurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        messageDev.queue
      );
      expect(queueConcurrency).toBe(1);

      // Dequeue from worker queue
      const dequeued = await queue.dequeueMessageFromWorkerQueue(
        "test_12345",
        authenticatedEnvDev.id,
        { blockingPop: false }
      );
      assertNonNullable(dequeued);

      // Nack the message (re-enqueue it)
      await queue.nackMessage({
        orgId: messageDev.orgId,
        messageId: dequeued.messageId,
        retryAt: Date.now() + 1000,
      });

      // Queue concurrency should be released
      const queueConcurrencyAfter = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        messageDev.queue
      );
      expect(queueConcurrencyAfter).toBe(0);

      // Message should now be in the queue sorted set
      const queueLength = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
      expect(queueLength).toBe(1);
    } finally {
      await queue.quit();
    }
  });
});
