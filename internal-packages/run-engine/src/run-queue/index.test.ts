import { redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "node:test";
import { setTimeout } from "node:timers/promises";
import { RunQueue } from "./index.js";
import { InputPayload } from "./types.js";
import { createRedisClient } from "@internal/redis";
import { FairQueueSelectionStrategy } from "./fairQueueSelectionStrategy.js";
import { RunQueueFullKeyProducer } from "./keyProducer.js";

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

const authenticatedEnvDev = {
  id: "e1234",
  type: "DEVELOPMENT" as const,
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

describe("RunQueue", () => {
  redisTest("Get/set Queue concurrency limit", { timeout: 15_000 }, async ({ redisContainer }) => {
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
      //initial value
      const initial = await queue.getQueueConcurrencyLimit(authenticatedEnvProd, "task/my-task");
      expect(initial).toBe(undefined);

      //set 20
      const result = await queue.updateQueueConcurrencyLimits(
        authenticatedEnvProd,
        "task/my-task",
        20
      );
      expect(result).toBe("OK");

      //get 20
      const updated = await queue.getQueueConcurrencyLimit(authenticatedEnvProd, "task/my-task");
      expect(updated).toBe(20);

      //remove
      const result2 = await queue.removeQueueConcurrencyLimits(
        authenticatedEnvProd,
        "task/my-task"
      );
      expect(result2).toBe(1);

      //get undefined
      const removed = await queue.getQueueConcurrencyLimit(authenticatedEnvProd, "task/my-task");
      expect(removed).toBe(undefined);
    } finally {
      await queue.quit();
    }
  });

  redisTest("Update env concurrency limits", { timeout: 5_000 }, async ({ redisContainer }) => {
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
      //initial value
      const initial = await queue.getEnvConcurrencyLimit(authenticatedEnvProd);
      expect(initial).toBe(25);

      //set 20
      await queue.updateEnvConcurrencyLimits({
        ...authenticatedEnvProd,
        maximumConcurrencyLimit: 20,
      });

      //get 20
      const updated = await queue.getEnvConcurrencyLimit(authenticatedEnvProd);
      expect(updated).toBe(20);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "Enqueue/Dequeue a message in env (DEV run, no concurrency key)",
    { timeout: 5_000 },
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
        const oldestScore2 = await queue.oldestMessageInQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(oldestScore2).toBe(messageDev.timestamp);

        //concurrencies
        const queueConcurrency = await queue.currentConcurrencyOfQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(queueConcurrency).toBe(0);
        const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
        expect(envConcurrency).toBe(0);

        const dequeued = await queue.dequeueMessageFromMasterQueue(
          "test_12345",
          envMasterQueue,
          10
        );
        expect(dequeued.length).toBe(1);
        expect(dequeued[0].messageId).toEqual(messageDev.runId);
        expect(dequeued[0].message.orgId).toEqual(messageDev.orgId);
        expect(dequeued[0].message.version).toEqual("1");
        expect(dequeued[0].message.masterQueues).toEqual(["main", envMasterQueue]);

        //concurrencies
        const queueConcurrency2 = await queue.currentConcurrencyOfQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(queueConcurrency2).toBe(1);
        const envConcurrency2 = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
        expect(envConcurrency2).toBe(1);

        //queue lengths
        const result3 = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
        expect(result3).toBe(0);
        const envQueueLength3 = await queue.lengthOfEnvQueue(authenticatedEnvDev);
        expect(envQueueLength3).toBe(0);

        const dequeued2 = await queue.dequeueMessageFromMasterQueue(
          "test_12345",
          envMasterQueue,
          10
        );
        expect(dequeued2.length).toBe(0);

        const dequeued3 = await queue.dequeueMessageFromMasterQueue("test_12345", "main", 10);
        expect(dequeued3.length).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "Enqueue/Dequeue a message from the main queue (PROD run, no concurrency key)",
    { timeout: 5_000 },
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
        //initial queue length
        const result = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
        expect(result).toBe(0);
        const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvProd);
        expect(envQueueLength).toBe(0);

        //initial oldest message
        const oldestScore = await queue.oldestMessageInQueue(
          authenticatedEnvProd,
          messageProd.queue
        );
        expect(oldestScore).toBe(undefined);

        const envMasterQueue = `env:${authenticatedEnvDev.id}`;

        //enqueue message
        await queue.enqueueMessage({
          env: authenticatedEnvProd,
          message: messageProd,
          masterQueues: ["main", envMasterQueue],
        });

        //queue length
        const queueLength = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
        expect(queueLength).toBe(1);
        const envLength = await queue.lengthOfEnvQueue(authenticatedEnvProd);
        expect(envLength).toBe(1);

        //oldest message
        const oldestScore2 = await queue.oldestMessageInQueue(
          authenticatedEnvProd,
          messageProd.queue
        );
        expect(oldestScore2).toBe(messageProd.timestamp);

        //concurrencies
        const queueConcurrency = await queue.currentConcurrencyOfQueue(
          authenticatedEnvProd,
          messageProd.queue
        );
        expect(queueConcurrency).toBe(0);
        const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd);
        expect(envConcurrency).toBe(0);

        //dequeue
        const dequeued = await queue.dequeueMessageFromMasterQueue("test_12345", "main", 10);
        expect(dequeued.length).toBe(1);
        expect(dequeued[0].messageId).toEqual(messageProd.runId);
        expect(dequeued[0].message.orgId).toEqual(messageProd.orgId);
        expect(dequeued[0].message.version).toEqual("1");
        expect(dequeued[0].message.masterQueues).toEqual(["main", envMasterQueue]);

        //concurrencies
        const queueConcurrency2 = await queue.currentConcurrencyOfQueue(
          authenticatedEnvProd,
          messageProd.queue
        );
        expect(queueConcurrency2).toBe(1);
        const envConcurrency2 = await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd);
        expect(envConcurrency2).toBe(1);

        //queue length
        const length2 = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
        expect(length2).toBe(0);
        const envLength2 = await queue.lengthOfEnvQueue(authenticatedEnvProd);
        expect(envLength2).toBe(0);

        const dequeued2 = await queue.dequeueMessageFromMasterQueue("test_12345", "main", 10);
        expect(dequeued2.length).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );

  // This test fails now because we only return a single run per env. We will change this in the future.
  redisTest.fails(
    "Dequeue multiple messages from the queue",
    { timeout: 5_000 },
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
        // Create 20 messages with different runIds and some with different queues
        const messages = Array.from({ length: 20 }, (_, i) => ({
          ...messageProd,
          taskIdentifier: i < 15 ? "task/my-task" : "task/other-task", // Mix up the queues
          runId: `r${i + 1}`,
          queue: i < 15 ? "task/my-task" : "task/other-task", // Mix up the queues
        }));

        // Enqueue all messages
        for (const message of messages) {
          await queue.enqueueMessage({
            env: authenticatedEnvProd,
            message,
            masterQueues: "main",
          });
        }

        // Check initial queue lengths
        const initialLength1 = await queue.lengthOfQueue(authenticatedEnvProd, "task/my-task");
        const initialLength2 = await queue.lengthOfQueue(authenticatedEnvProd, "task/other-task");
        expect(initialLength1).toBe(15);
        expect(initialLength2).toBe(5);
        const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvProd);
        expect(envQueueLength).toBe(20);

        // Dequeue first batch of 10 messages
        const dequeued1 = await queue.dequeueMessageFromMasterQueue("test_12345", "main", 10);
        expect(dequeued1.length).toBe(10);

        // Dequeue second batch of 10 messages
        const dequeued2 = await queue.dequeueMessageFromMasterQueue("test_12345", "main", 10);
        expect(dequeued2.length).toBe(10);

        // Combine all dequeued message IDs
        const dequeuedIds = [...dequeued1, ...dequeued2].map((m) => m.messageId);

        // Check that all original messages were dequeued
        const allOriginalIds = messages.map((m) => m.runId);
        expect(dequeuedIds.sort()).toEqual(allOriginalIds.sort());

        // Try to dequeue more - should get none
        const dequeued3 = await queue.dequeueMessageFromMasterQueue("test_12345", "main", 10);
        expect(dequeued3.length).toBe(0);

        // Check final queue lengths
        const finalLength1 = await queue.lengthOfQueue(authenticatedEnvProd, "task/my-task");
        const finalLength2 = await queue.lengthOfQueue(authenticatedEnvProd, "task/other-task");
        expect(finalLength1).toBe(0);
        expect(finalLength2).toBe(0);
        const finalEnvQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvProd);
        expect(finalEnvQueueLength).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("Acking", { timeout: 5_000 }, async ({ redisContainer, redisOptions }) => {
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

    const redis = createRedisClient({ ...redisOptions, keyPrefix: "runqueue:test:" });

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvProd,
        message: messageProd,
        masterQueues: "main",
      });

      const queueLength = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
      expect(queueLength).toBe(1);
      const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvProd);
      expect(envQueueLength).toBe(1);

      const messages = await queue.dequeueMessageFromMasterQueue("test_12345", "main", 10);
      expect(messages.length).toBe(1);

      const queueLength2 = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
      expect(queueLength2).toBe(0);
      const envQueueLength2 = await queue.lengthOfEnvQueue(authenticatedEnvProd);
      expect(envQueueLength2).toBe(0);

      //check the message is gone
      const key = queue.keys.messageKey(messages[0].message.orgId, messages[0].messageId);
      const exists = await redis.exists(key);
      expect(exists).toBe(1);

      await queue.acknowledgeMessage(messages[0].message.orgId, messages[0].messageId);

      //concurrencies
      const queueConcurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvProd,
        messageProd.queue
      );
      expect(queueConcurrency).toBe(0);
      const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd);
      expect(envConcurrency).toBe(0);

      //queue lengths
      const queueLength3 = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
      expect(queueLength3).toBe(0);
      const envQueueLength3 = await queue.lengthOfEnvQueue(authenticatedEnvProd);
      expect(envQueueLength3).toBe(0);

      //check the message is gone
      const exists2 = await redis.exists(key);
      expect(exists2).toBe(0);

      //dequeue
      const messages2 = await queue.dequeueMessageFromMasterQueue("test_12345", "main", 10);
      expect(messages2.length).toBe(0);
    } finally {
      try {
        await queue.quit();
        await redis.quit();
      } catch (e) {}
    }
  });

  redisTest("Ack (before dequeue)", { timeout: 5_000 }, async ({ redisContainer }) => {
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
        masterQueues: "main",
      });

      const queueLength = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
      expect(queueLength).toBe(1);
      const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvProd);
      expect(envQueueLength).toBe(1);

      await queue.acknowledgeMessage(messageProd.orgId, messageProd.runId);

      //concurrencies
      const queueConcurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvProd,
        messageProd.queue
      );
      expect(queueConcurrency).toBe(0);
      const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd);
      expect(envConcurrency).toBe(0);

      //queue lengths
      const queueLength3 = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
      expect(queueLength3).toBe(0);
      const envQueueLength3 = await queue.lengthOfEnvQueue(authenticatedEnvProd);
      expect(envQueueLength3).toBe(0);

      //dequeue
      const messages2 = await queue.dequeueMessageFromMasterQueue("test_12345", "main", 10);
      expect(messages2.length).toBe(0);
    } finally {
      await queue.quit();
    }
  });

  redisTest("Nacking", { timeout: 15_000 }, async ({ redisContainer, redisOptions }) => {
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

    const redis = createRedisClient({ ...redisOptions, keyPrefix: "runqueue:test:" });

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvProd,
        message: messageProd,
        masterQueues: "main2",
      });

      const messages = await queue.dequeueMessageFromMasterQueue("test_12345", "main2", 10);
      expect(messages.length).toBe(1);

      //check the message is there
      const key = queue.keys.messageKey(messages[0].message.orgId, messages[0].messageId);
      const exists = await redis.exists(key);
      expect(exists).toBe(1);

      //concurrencies
      const queueConcurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvProd,
        messageProd.queue
      );
      expect(queueConcurrency).toBe(1);
      const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd);
      expect(envConcurrency).toBe(1);

      await queue.nackMessage({
        orgId: messages[0].message.orgId,
        messageId: messages[0].messageId,
      });

      //we need to wait because the default wait is 1 second
      await setTimeout(300);

      //concurrencies
      const queueConcurrency2 = await queue.currentConcurrencyOfQueue(
        authenticatedEnvProd,
        messageProd.queue
      );
      expect(queueConcurrency2).toBe(0);
      const envConcurrency2 = await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd);
      expect(envConcurrency2).toBe(0);

      //queue lengths
      const queueLength = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
      expect(queueLength).toBe(1);
      const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvProd);
      expect(envQueueLength).toBe(1);

      //check the message is there
      const exists2 = await redis.exists(key);
      expect(exists2).toBe(1);

      //dequeue
      const messages2 = await queue.dequeueMessageFromMasterQueue("test_12345", "main2", 10);
      expect(messages2[0].messageId).toBe(messageProd.runId);
    } finally {
      try {
        await queue.quit();
        await redis.quit();
      } catch (e) {}
    }
  });

  redisTest("Releasing concurrency", async ({ redisContainer, redisOptions }) => {
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

    const redis = createRedisClient({ ...redisOptions, keyPrefix: "runqueue:test:" });

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvProd,
        message: messageProd,
        masterQueues: "main",
      });

      const messages = await queue.dequeueMessageFromMasterQueue("test_12345", "main", 10);
      expect(messages.length).toBe(1);

      //check the message is gone
      const key = queue.keys.messageKey(messages[0].message.orgId, messages[0].messageId);
      const exists = await redis.exists(key);
      expect(exists).toBe(1);

      //concurrencies
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
        1
      );
      expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);

      //release the concurrency
      await queue.releaseAllConcurrency(
        authenticatedEnvProd.organization.id,
        messages[0].messageId
      );

      //concurrencies
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
        0
      );
      expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(0);

      //reacquire the concurrency
      await queue.reacquireConcurrency(authenticatedEnvProd.organization.id, messages[0].messageId);

      //check concurrencies are back to what they were before
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
        1
      );
      expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);

      //release the concurrency (with the queue this time)
      await queue.releaseAllConcurrency(
        authenticatedEnvProd.organization.id,
        messages[0].messageId
      );

      //concurrencies
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
        0
      );
      expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(0);

      //reacquire the concurrency
      await queue.reacquireConcurrency(authenticatedEnvProd.organization.id, messages[0].messageId);

      //check concurrencies are back to what they were before
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
        1
      );
      expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);
    } finally {
      try {
        await queue.quit();
        await redis.quit();
      } catch (e) {}
    }
  });

  redisTest("Dead Letter Queue", async ({ redisContainer, redisOptions }) => {
    const queue = new RunQueue({
      ...testOptions,
      retryOptions: {
        maxAttempts: 1,
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

    const redis = createRedisClient({ ...redisOptions, keyPrefix: "runqueue:test:" });

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvProd,
        message: messageProd,
        masterQueues: "main",
      });

      const messages = await queue.dequeueMessageFromMasterQueue("test_12345", "main", 10);
      expect(messages.length).toBe(1);

      //check the message is there
      const key = queue.keys.messageKey(messages[0].message.orgId, messages[0].messageId);
      const exists = await redis.exists(key);
      expect(exists).toBe(1);

      //nack (we only have attempts set to 1)
      await queue.nackMessage({
        orgId: messages[0].message.orgId,
        messageId: messages[0].messageId,
      });

      //dequeue
      const messages2 = await queue.dequeueMessageFromMasterQueue("test_12345", "main", 10);
      expect(messages2.length).toBe(0);

      //concurrencies
      const queueConcurrency2 = await queue.currentConcurrencyOfQueue(
        authenticatedEnvProd,
        messageProd.queue
      );
      expect(queueConcurrency2).toBe(0);
      const envConcurrency2 = await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd);
      expect(envConcurrency2).toBe(0);

      //check the message is still there
      const message = await queue.readMessage(messages[0].message.orgId, messages[0].messageId);
      expect(message).toBeDefined();

      const deadLetterQueueLengthBefore = await queue.lengthOfDeadLetterQueue(authenticatedEnvProd);
      expect(deadLetterQueueLengthBefore).toBe(1);

      const existsInDlq = await queue.messageInDeadLetterQueue(
        authenticatedEnvProd,
        messageProd.runId
      );
      expect(existsInDlq).toBe(true);

      //redrive
      await queue.redriveMessage(authenticatedEnvProd, messageProd.runId);

      // Wait for the item to be redrived and processed
      await setTimeout(5_000);

      //shouldn't be in the dlq now
      const existsInDlqAfter = await queue.messageInDeadLetterQueue(
        authenticatedEnvProd,
        messageProd.runId
      );
      expect(existsInDlqAfter).toBe(false);

      //dequeue
      const messages3 = await queue.dequeueMessageFromMasterQueue("test_12345", "main", 10);
      expect(messages3[0].messageId).toBe(messageProd.runId);
    } finally {
      try {
        await queue.quit();
        await redis.quit();
      } catch (e) {}
    }
  });
});
