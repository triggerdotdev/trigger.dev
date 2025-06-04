import { assertNonNullable, redisTest } from "@internal/testcontainers";
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
  logger: new Logger("RunQueue", "debug"),
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
  redisTest(
    "Enqueue/Dequeue a message in env (DEV run, no concurrency key)",
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

        //enqueue message
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          workerQueue: authenticatedEnvDev.id,
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

        await setTimeout(1000);

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

        const dequeued2 = await queue.dequeueMessageFromWorkerQueue(
          "test_12345",
          authenticatedEnvDev.id
        );
        expect(dequeued2).toBe(undefined);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "Enqueue/Dequeue a message from the main queue (PROD run, no concurrency key)",
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

        //enqueue message
        await queue.enqueueMessage({
          env: authenticatedEnvProd,
          message: messageProd,
          workerQueue: "main",
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

        await setTimeout(1000);

        //dequeue
        const dequeued = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");

        assertNonNullable(dequeued);
        expect(dequeued).toBeDefined();
        expect(dequeued!.messageId).toEqual(messageProd.runId);
        expect(dequeued!.message.orgId).toEqual(messageProd.orgId);
        expect(dequeued!.message.version).toEqual("2");

        const workerQueue =
          dequeued.message.version == "2" ? dequeued.message.workerQueue : undefined;
        expect(workerQueue).toEqual("main");

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

        const dequeued2 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        expect(dequeued2).toBe(undefined);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "Enqueue/Dequeue a message with dequeue consumers disabled",
    async ({ redisContainer }) => {
      const queue = new RunQueue({
        ...testOptions,
        masterQueueConsumersDisabled: true,
        processWorkerQueueDebounceMs: 50,
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

        //enqueue message
        await queue.enqueueMessage({
          env: authenticatedEnvProd,
          message: messageProd,
          workerQueue: "main",
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

        await setTimeout(1000);

        //dequeue
        const dequeued = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");

        assertNonNullable(dequeued);
        expect(dequeued).toBeDefined();
        expect(dequeued!.messageId).toEqual(messageProd.runId);
        expect(dequeued!.message.orgId).toEqual(messageProd.orgId);
        expect(dequeued!.message.version).toEqual("2");

        const workerQueue =
          dequeued.message.version == "2" ? dequeued.message.workerQueue : undefined;
        expect(workerQueue).toEqual("main");

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

        const dequeued2 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        expect(dequeued2).toBe(undefined);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "Dequeue a message when another message on the same queue is acked",
    async ({ redisContainer }) => {
      const queue = new RunQueue({
        ...testOptions,
        masterQueueConsumersDisabled: true,
        processWorkerQueueDebounceMs: 50,
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
        await queue.updateQueueConcurrencyLimits(authenticatedEnvProd, messageProd.queue, 1);

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

        //enqueue message
        await queue.enqueueMessage({
          env: authenticatedEnvProd,
          message: messageProd,
          workerQueue: "main",
          skipDequeueProcessing: true,
        });

        // Enqueue another message
        await queue.enqueueMessage({
          env: authenticatedEnvProd,
          message: { ...messageProd, runId: "r4322" },
          workerQueue: "main",
          skipDequeueProcessing: true,
        });

        //queue length
        const queueLength = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
        expect(queueLength).toBe(2);
        const envLength = await queue.lengthOfEnvQueue(authenticatedEnvProd);
        expect(envLength).toBe(2);

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

        // Process the message so it can be dequeued
        await queue.processMasterQueueForEnvironment(authenticatedEnvProd.id, 1);

        //dequeue
        const dequeued = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");

        assertNonNullable(dequeued);
        expect(dequeued).toBeDefined();
        expect(dequeued!.messageId).toEqual(messageProd.runId);
        expect(dequeued!.message.orgId).toEqual(messageProd.orgId);
        expect(dequeued!.message.version).toEqual("2");

        // Now lets ack the message
        await queue.acknowledgeMessage(messageProd.orgId, messageProd.runId);

        await setTimeout(1000);

        // Now we can dequeue the other message
        const dequeued2 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        assertNonNullable(dequeued2);
        expect(dequeued2).toBeDefined();
        expect(dequeued2!.messageId).toEqual("r4322");
        expect(dequeued2!.message.orgId).toEqual(messageProd.orgId);
        expect(dequeued2!.message.version).toEqual("2");
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("Enqueue/Dequeue with 8 shards", async ({ redisContainer }) => {
    const queue = new RunQueue({
      ...testOptions,
      shardCount: 8,
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
      const oldestScore = await queue.oldestMessageInQueue(authenticatedEnvProd, messageProd.queue);
      expect(oldestScore).toBe(undefined);

      //enqueue message
      await queue.enqueueMessage({
        env: authenticatedEnvProd,
        message: messageProd,
        workerQueue: "main",
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

      await setTimeout(1000);

      //dequeue
      const dequeued = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");

      assertNonNullable(dequeued);
      expect(dequeued).toBeDefined();
      expect(dequeued!.messageId).toEqual(messageProd.runId);
      expect(dequeued!.message.orgId).toEqual(messageProd.orgId);
      expect(dequeued!.message.version).toEqual("2");

      const workerQueue =
        dequeued.message.version == "2" ? dequeued.message.workerQueue : undefined;
      expect(workerQueue).toEqual("main");

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

      const dequeued2 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
      expect(dequeued2).toBe(undefined);
    } finally {
      await queue.quit();
    }
  });

  redisTest("Acking", async ({ redisContainer, redisOptions }) => {
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
        workerQueue: "main",
      });

      const queueLength = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
      expect(queueLength).toBe(1);
      const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvProd);
      expect(envQueueLength).toBe(1);

      await setTimeout(1000);

      const message = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
      expect(message).toBeDefined();

      assertNonNullable(message);

      const queueLength2 = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
      expect(queueLength2).toBe(0);
      const envQueueLength2 = await queue.lengthOfEnvQueue(authenticatedEnvProd);
      expect(envQueueLength2).toBe(0);

      //check the message is gone
      const key = queue.keys.messageKey(message.message.orgId, message.messageId);
      const exists = await redis.exists(key);
      expect(exists).toBe(1);

      await queue.acknowledgeMessage(message.message.orgId, message.messageId);

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
      const message2 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
      expect(message2).toBe(undefined);
    } finally {
      try {
        await queue.quit();
        await redis.quit();
      } catch (e) {}
    }
  });

  redisTest("Ack (before dequeue)", async ({ redisContainer }) => {
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
        workerQueue: "main",
      });

      const queueLength = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
      expect(queueLength).toBe(1);
      const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvProd);
      expect(envQueueLength).toBe(1);

      await setTimeout(1000);

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
      const message2 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
      expect(message2).toBe(undefined);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "Ack after moving to workerQueue with removeFromWorkerQueue = undefined",
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
          workerQueue: "main",
        });

        const queueLength = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
        expect(queueLength).toBe(1);
        const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvProd);
        expect(envQueueLength).toBe(1);

        await setTimeout(1000);

        await queue.acknowledgeMessage(messageProd.orgId, messageProd.runId);

        const messages = await queue.peekAllOnWorkerQueue("main");
        expect(messages.length).toEqual(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "Ack after moving to workerQueue with removeFromWorkerQueue = true",
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
          workerQueue: "main",
        });

        const queueLength = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
        expect(queueLength).toBe(1);
        const envQueueLength = await queue.lengthOfEnvQueue(authenticatedEnvProd);
        expect(envQueueLength).toBe(1);

        await setTimeout(1000);

        await queue.acknowledgeMessage(messageProd.orgId, messageProd.runId, {
          removeFromWorkerQueue: true,
        });

        const messages = await queue.peekAllOnWorkerQueue("main");
        expect(messages.length).toEqual(0);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("Nacking", async ({ redisContainer, redisOptions }) => {
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
        workerQueue: "main",
      });

      await setTimeout(1000);

      const message = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
      expect(message).toBeDefined();

      assertNonNullable(message);

      //check the message is there
      const key = queue.keys.messageKey(message.message.orgId, message.messageId);
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
        orgId: message.message.orgId,
        messageId: message.messageId,
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

      await setTimeout(1000);

      //dequeue
      const messages2 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
      expect(messages2).toBeDefined();
      assertNonNullable(messages2);
      expect(messages2.messageId).toBe(messageProd.runId);
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
        workerQueue: "main",
      });

      await setTimeout(1000);

      const message = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
      expect(message).toBeDefined();

      assertNonNullable(message);

      //check the message is gone
      const key = queue.keys.messageKey(message.message.orgId, message.messageId);
      const exists = await redis.exists(key);
      expect(exists).toBe(1);

      //concurrencies
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
        1
      );
      expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);

      //release the concurrency
      await queue.releaseAllConcurrency(authenticatedEnvProd.organization.id, message.messageId);

      //concurrencies
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
        0
      );
      expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(0);

      //reacquire the concurrency
      await queue.reacquireConcurrency(authenticatedEnvProd.organization.id, message.messageId);

      //check concurrencies are back to what they were before
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
        1
      );
      expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);

      //release the concurrency (with the queue this time)
      await queue.releaseAllConcurrency(authenticatedEnvProd.organization.id, message.messageId);

      //concurrencies
      expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
        0
      );
      expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(0);

      //reacquire the concurrency
      await queue.reacquireConcurrency(authenticatedEnvProd.organization.id, message.messageId);

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
        workerQueue: "main",
      });

      await setTimeout(1000);

      const message = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
      expect(message).toBeDefined();

      assertNonNullable(message);

      //check the message is there
      const key = queue.keys.messageKey(message.message.orgId, message.messageId);
      const exists = await redis.exists(key);
      expect(exists).toBe(1);

      //nack (we only have attempts set to 1)
      await queue.nackMessage({
        orgId: message.message.orgId,
        messageId: message.messageId,
      });

      //dequeue
      const message2 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
      expect(message2).toBe(undefined);

      //concurrencies
      const queueConcurrency2 = await queue.currentConcurrencyOfQueue(
        authenticatedEnvProd,
        messageProd.queue
      );
      expect(queueConcurrency2).toBe(0);
      const envConcurrency2 = await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd);
      expect(envConcurrency2).toBe(0);

      //check the message is still there
      const messageRead = await queue.readMessage(message.message.orgId, message.messageId);
      expect(messageRead).toBeDefined();

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
      const message3 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
      expect(message3).toBeDefined();
      assertNonNullable(message3);
      expect(message3.messageId).toBe(messageProd.runId);
    } finally {
      try {
        await queue.quit();
        await redis.quit();
      } catch (e) {}
    }
  });
});
