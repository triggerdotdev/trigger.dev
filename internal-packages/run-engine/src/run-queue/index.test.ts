import { trace } from "@opentelemetry/api";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "node:test";
import { redisTest } from "@internal/testcontainers";
import { RunQueue } from "./index.js";
import { RunQueueShortKeyProducer } from "./keyProducer.js";
import { SimpleWeightedChoiceStrategy } from "./simpleWeightedPriorityStrategy.js";
import { InputPayload } from "./types.js";
import { abort } from "node:process";

const testOptions = {
  name: "rq",
  tracer: trace.getTracer("rq"),
  queuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 36 }),
  envQueuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 12 }),
  workers: 1,
  defaultEnvConcurrency: 10,
  enableRebalancing: false,
  logger: new Logger("RunQueue", "warn"),
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
};

describe("RunQueue", () => {
  redisTest(
    "Get/set Queue concurrency limit",
    { timeout: 5_000 },
    async ({ redisContainer, redis }) => {
      const queue = new RunQueue({
        ...testOptions,
        redis: { host: redisContainer.getHost(), port: redisContainer.getPort() },
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
    }
  );

  redisTest(
    "Update env concurrency limits",
    { timeout: 5_000 },
    async ({ redisContainer, redis }) => {
      const queue = new RunQueue({
        ...testOptions,
        redis: { host: redisContainer.getHost(), port: redisContainer.getPort() },
      });

      try {
        //initial value
        const initial = await queue.getEnvConcurrencyLimit(authenticatedEnvProd);
        expect(initial).toBe(10);

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
    }
  );

  redisTest(
    "Enqueue/Dequeue a message in env (DEV run, no concurrency key)",
    { timeout: 5_000 },
    async ({ redisContainer, redis }) => {
      const queue = new RunQueue({
        ...testOptions,
        redis: { host: redisContainer.getHost(), port: redisContainer.getPort() },
      });

      try {
        //initial queue length
        const result = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
        expect(result).toBe(0);

        //initial oldest message
        const oldestScore = await queue.oldestMessageInQueue(authenticatedEnvDev, messageDev.queue);
        expect(oldestScore).toBe(undefined);

        const envMasterQueue = `env:${authenticatedEnvDev.id}`;

        //enqueue message
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          masterQueue: `env:${authenticatedEnvDev.id}`,
        });

        //queue length
        const result2 = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
        expect(result2).toBe(1);

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
        const projectConcurrency = await queue.currentConcurrencyOfProject(authenticatedEnvDev);
        expect(projectConcurrency).toBe(0);
        const taskConcurrency = await queue.currentConcurrencyOfTask(
          authenticatedEnvDev,
          messageDev.taskIdentifier
        );
        expect(taskConcurrency).toBe(0);

        const dequeued = await queue.dequeueMessageInSharedQueue("test_12345", envMasterQueue);
        expect(dequeued?.messageId).toEqual(messageDev.runId);
        expect(dequeued?.message.orgId).toEqual(messageDev.orgId);
        expect(dequeued?.message.version).toEqual("1");
        expect(dequeued?.message.masterQueue).toEqual(envMasterQueue);

        //concurrencies
        const queueConcurrency2 = await queue.currentConcurrencyOfQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(queueConcurrency2).toBe(1);
        const envConcurrency2 = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
        expect(envConcurrency2).toBe(1);
        const projectConcurrency2 = await queue.currentConcurrencyOfProject(authenticatedEnvDev);
        expect(projectConcurrency2).toBe(1);
        const taskConcurrency2 = await queue.currentConcurrencyOfTask(
          authenticatedEnvDev,
          messageDev.taskIdentifier
        );
        expect(taskConcurrency2).toBe(1);

        const dequeued2 = await queue.dequeueMessageInSharedQueue("test_12345", envMasterQueue);
        expect(dequeued2).toBe(undefined);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "Enqueue/Dequeue a message from the shared queue (PROD run, no concurrency key)",
    { timeout: 5_000 },
    async ({ redisContainer, redis }) => {
      const queue = new RunQueue({
        ...testOptions,
        redis: { host: redisContainer.getHost(), port: redisContainer.getPort() },
      });

      try {
        //initial queue length
        const result = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
        expect(result).toBe(0);

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
          masterQueue: "main",
        });

        //queue length
        const result2 = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
        expect(result2).toBe(1);

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
        const projectConcurrency = await queue.currentConcurrencyOfProject(authenticatedEnvProd);
        expect(projectConcurrency).toBe(0);
        const taskConcurrency = await queue.currentConcurrencyOfTask(
          authenticatedEnvProd,
          messageProd.taskIdentifier
        );
        expect(taskConcurrency).toBe(0);

        //dequeue
        const dequeued = await queue.dequeueMessageInSharedQueue("test_12345", "main");
        expect(dequeued?.messageId).toEqual(messageProd.runId);
        expect(dequeued?.message.orgId).toEqual(messageProd.orgId);
        expect(dequeued?.message.version).toEqual("1");
        expect(dequeued?.message.masterQueue).toEqual("main");

        //concurrencies
        const queueConcurrency2 = await queue.currentConcurrencyOfQueue(
          authenticatedEnvProd,
          messageProd.queue
        );
        expect(queueConcurrency2).toBe(1);
        const envConcurrency2 = await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd);
        expect(envConcurrency2).toBe(1);
        const projectConcurrency2 = await queue.currentConcurrencyOfProject(authenticatedEnvProd);
        expect(projectConcurrency2).toBe(1);
        const taskConcurrency2 = await queue.currentConcurrencyOfTask(
          authenticatedEnvProd,
          messageProd.taskIdentifier
        );
        expect(taskConcurrency2).toBe(1);

        //queue length
        const length2 = await queue.lengthOfQueue(authenticatedEnvProd, messageProd.queue);
        expect(length2).toBe(0);

        const dequeued2 = await queue.dequeueMessageInSharedQueue("test_12345", "main");
        expect(dequeued2).toBe(undefined);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("Get shared queue details", { timeout: 5_000 }, async ({ redisContainer, redis }) => {
    const queue = new RunQueue({
      ...testOptions,
      redis: { host: redisContainer.getHost(), port: redisContainer.getPort() },
    });

    try {
      const result = await queue.getSharedQueueDetails("main");
      expect(result.selectionId).toBe("getSharedQueueDetails");
      expect(result.queueCount).toBe(0);
      expect(result.queueChoice.choice).toStrictEqual({ abort: true });

      await queue.enqueueMessage({
        env: authenticatedEnvProd,
        message: messageProd,
        masterQueue: "main",
      });

      const result2 = await queue.getSharedQueueDetails("main");
      expect(result2.selectionId).toBe("getSharedQueueDetails");
      expect(result2.queueCount).toBe(1);
      expect(result2.queues[0].score).toBe(messageProd.timestamp);
      expect(result2.queueChoice.choice).toBe(
        "{org:o1234}:proj:p1234:env:e1234:queue:task/my-task"
      );
    } finally {
      await queue.quit();
    }
  });

  redisTest("Acking", { timeout: 5_000 }, async ({ redisContainer, redis }) => {
    const queue = new RunQueue({
      ...testOptions,
      redis: { host: redisContainer.getHost(), port: redisContainer.getPort() },
    });

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvProd,
        message: messageProd,
        masterQueue: "main",
      });

      const message = await queue.dequeueMessageInSharedQueue("test_12345", "main");
      expect(message).toBeDefined();

      //check the message is gone
      const key = queue.keys.messageKey(message!.message.orgId, message!.messageId);
      const exists = await redis.exists(key);
      expect(exists).toBe(1);

      await queue.acknowledgeMessage(message!.message.orgId, message!.messageId);

      //concurrencies
      const queueConcurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvProd,
        messageProd.queue
      );
      expect(queueConcurrency).toBe(0);
      const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd);
      expect(envConcurrency).toBe(0);
      const projectConcurrency = await queue.currentConcurrencyOfProject(authenticatedEnvProd);
      expect(projectConcurrency).toBe(0);
      const taskConcurrency = await queue.currentConcurrencyOfTask(
        authenticatedEnvProd,
        messageProd.taskIdentifier
      );
      expect(taskConcurrency).toBe(0);

      //check the message is gone
      const exists2 = await redis.exists(key);
      expect(exists2).toBe(0);

      //dequeue
      const message2 = await queue.dequeueMessageInSharedQueue("test_12345", "main");
      expect(message2).toBeUndefined();
    } finally {
      await queue.quit();
    }
  });

  redisTest("Nacking", { timeout: 5_000 }, async ({ redisContainer, redis }) => {
    const queue = new RunQueue({
      ...testOptions,
      redis: { host: redisContainer.getHost(), port: redisContainer.getPort() },
    });

    try {
      await queue.enqueueMessage({
        env: authenticatedEnvProd,
        message: messageProd,
        masterQueue: "main",
      });

      const message = await queue.dequeueMessageInSharedQueue("test_12345", "main");
      expect(message).toBeDefined();

      //check the message is there
      const key = queue.keys.messageKey(message!.message.orgId, message!.messageId);
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
      const projectConcurrency = await queue.currentConcurrencyOfProject(authenticatedEnvProd);
      expect(projectConcurrency).toBe(1);
      const taskConcurrency = await queue.currentConcurrencyOfTask(
        authenticatedEnvProd,
        messageProd.taskIdentifier
      );
      expect(taskConcurrency).toBe(1);

      await queue.nackMessage(message!.message.orgId, message!.messageId);

      //concurrencies
      const queueConcurrency2 = await queue.currentConcurrencyOfQueue(
        authenticatedEnvProd,
        messageProd.queue
      );
      expect(queueConcurrency2).toBe(0);
      const envConcurrency2 = await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd);
      expect(envConcurrency2).toBe(0);
      const projectConcurrency2 = await queue.currentConcurrencyOfProject(authenticatedEnvProd);
      expect(projectConcurrency2).toBe(0);
      const taskConcurrency2 = await queue.currentConcurrencyOfTask(
        authenticatedEnvProd,
        messageProd.taskIdentifier
      );
      expect(taskConcurrency2).toBe(0);

      //check the message is there
      const exists2 = await redis.exists(key);
      expect(exists2).toBe(1);

      //dequeue
      const message2 = await queue.dequeueMessageInSharedQueue("test_12345", "main");
      expect(message2?.messageId).toBe(messageProd.runId);
    } finally {
      await queue.quit();
    }
  });
});