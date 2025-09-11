import { assertNonNullable, redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { describe } from "node:test";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import { InputPayload } from "../types.js";
import { setTimeout } from "node:timers/promises";
import { Decimal } from "@trigger.dev/database";

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

describe("RunQueue.dequeueMessageFromWorkerQueue", () => {
  redisTest("dequeuing a message from a worker queue", async ({ redisContainer }) => {
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
        workerQueue: "main",
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

      await setTimeout(1000);

      const dequeued = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
      expect(dequeued).toBeDefined();
      assertNonNullable(dequeued);
      expect(dequeued.messageId).toEqual(messageDev.runId);
      expect(dequeued.message.orgId).toEqual(messageDev.orgId);
      expect(dequeued.message.version).toEqual("2");

      const workerQueue =
        dequeued.message.version === "2" ? dequeued.message.workerQueue : undefined;
      expect(workerQueue).toEqual("main");

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

        // Enqueue first message
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          workerQueue: "main",
        });

        // Dequeue first message to occupy the concurrency
        await setTimeout(1000);

        const dequeued1 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        assertNonNullable(dequeued1);

        // Enqueue second message
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: { ...messageDev, runId: "r4322" },
          workerQueue: "main",
        });

        await setTimeout(1000);

        // Try to dequeue second message
        const dequeued2 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        expect(dequeued2).toBeUndefined();

        const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
        expect(envConcurrency).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "should not dequeue when env current concurrency equals env concurrency limit with burst factor",
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
          concurrencyLimitBurstFactor: new Decimal(2.0),
        });

        // Enqueue first message
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          workerQueue: "main",
        });

        // Dequeue first message to occupy the concurrency
        await setTimeout(1000);

        const dequeued1 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        assertNonNullable(dequeued1);

        // Enqueue second message
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: { ...messageDev, runId: "r4322", queue: "task/my-task-2" },
          workerQueue: "main",
        });

        await setTimeout(1000);

        // Try to dequeue second message
        const dequeued2 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        expect(dequeued2).toBeDefined();
        assertNonNullable(dequeued2);
        expect(dequeued2.messageId).toEqual("r4322");
        expect(dequeued2.message.orgId).toEqual(messageDev.orgId);
        expect(dequeued2.message.version).toEqual("2");

        const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
        expect(envConcurrency).toBe(2);

        // Enqueue the third message
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: { ...messageDev, runId: "r4323", queue: "task/my-task-3" },
          workerQueue: "main",
        });

        await setTimeout(1000);

        // Try to dequeue third message
        const dequeued3 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        expect(dequeued3).toBeUndefined();

        const envConcurrencyAfter = await queue.currentConcurrencyOfEnvironment(
          authenticatedEnvDev
        );
        expect(envConcurrencyAfter).toBe(2);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "should dequeue when env current concurrency equals env concurrency limit with burst factor",
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
          concurrencyLimitBurstFactor: new Decimal(2.0),
        });

        // Enqueue first message
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          workerQueue: "main",
        });

        // Dequeue first message to occupy the concurrency
        await setTimeout(1000);

        const dequeued1 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        assertNonNullable(dequeued1);

        // Enqueue second message
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: { ...messageDev, runId: "r4322", queue: "task/my-task-2" },
          workerQueue: "main",
        });

        await setTimeout(1000);

        // Try to dequeue second message
        const dequeued2 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        expect(dequeued2).toBeDefined();
        assertNonNullable(dequeued2);
        expect(dequeued2.messageId).toEqual("r4322");
        expect(dequeued2.message.orgId).toEqual(messageDev.orgId);
        expect(dequeued2.message.version).toEqual("2");

        const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
        expect(envConcurrency).toBe(2);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "should not dequeue on a single queue when env current concurrency equals env concurrency limit with burst factor",
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
          concurrencyLimitBurstFactor: new Decimal(2.0),
        });

        // Enqueue first message
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          workerQueue: "main",
        });

        // Dequeue first message to occupy the concurrency
        await setTimeout(1000);

        const dequeued1 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        assertNonNullable(dequeued1);

        // Enqueue second message
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: { ...messageDev, runId: "r4322" },
          workerQueue: "main",
        });

        await setTimeout(1000);

        // Try to dequeue second message
        const dequeued2 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        expect(dequeued2).toBeUndefined();

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

        // Enqueue two messages
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          workerQueue: "main",
        });

        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: { ...messageDev, runId: "r4322" },
          workerQueue: "main",
        });

        await setTimeout(1000);

        // Dequeue first message
        const dequeued1 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        expect(dequeued1).toBeDefined();
        assertNonNullable(dequeued1);

        // Try to dequeue second message
        const dequeued2 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        expect(dequeued2).toBeUndefined();

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

  redisTest(
    "should put the queue in a cooloff state when it fails to dequeue after a certain number of consecutive failures",
    async ({ redisContainer }) => {
      const queue = new RunQueue({
        ...testOptions,
        logLevel: "debug",
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
        masterQueueCooloffPeriodMs: 10_000,
        masterQueueCooloffCountThreshold: 1,
        masterQueueConsumersIntervalMs: 500,
        masterQueueConsumerDequeueCount: 1,
        dequeueBlockingTimeoutSeconds: 1,
      });

      try {
        // Set queue concurrency limit to 1
        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, messageDev.queue, 1);

        // Enqueue two messages
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          workerQueue: "main",
        });

        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: { ...messageDev, runId: "r4322" },
          workerQueue: "main",
        });

        await setTimeout(1000);

        // Dequeue first message
        const dequeued1 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        expect(dequeued1).toBeDefined();
        assertNonNullable(dequeued1);

        // Try to dequeue second message
        const dequeued2 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        expect(dequeued2).toBeUndefined();

        const queueConcurrency = await queue.currentConcurrencyOfQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(queueConcurrency).toBe(1);

        // Now lets ack the first message (and skip dequeue processing so we can test the cooloff state)
        await queue.acknowledgeMessage(dequeued1.message.orgId, dequeued1.messageId, {
          skipDequeueProcessing: true,
        });

        await setTimeout(1000);

        // Try and dequeue the second message again (should still be in the cooloff state)
        const dequeued3 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        expect(dequeued3).toBeUndefined();

        // Wait for the cooloff period to end
        await setTimeout(10_000);

        // Try and dequeue the second message again (should be dequeued now)
        const dequeued4 = await queue.dequeueMessageFromWorkerQueue("test_12345", "main");
        expect(dequeued4).toBeDefined();
        assertNonNullable(dequeued4);
        expect(dequeued4.messageId).toEqual("r4322");
        expect(dequeued4.message.orgId).toEqual(messageDev.orgId);
        expect(dequeued4.message.version).toEqual("2");
      } finally {
        await queue.quit();
      }
    }
  );
});
