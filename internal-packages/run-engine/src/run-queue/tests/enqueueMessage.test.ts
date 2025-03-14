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

describe("RunQueue.enqueueMessage", () => {
  redisTest("enqueueMessage with no reserved concurrency", async ({ redisContainer }) => {
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
      const enqueueResult = await queue.enqueueMessage({
        env: authenticatedEnvDev,
        message: messageDev,
        masterQueues: ["main", envMasterQueue],
      });

      expect(enqueueResult).toBe(true);

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

      const envReserveConcurrency = await queue.reserveConcurrencyOfEnvironment(
        authenticatedEnvDev
      );
      expect(envReserveConcurrency).toBe(0);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "enqueueMessage with non-recursive reserved concurrency adds to the environment's reserved concurrency",
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
        const enqueueResult = await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          masterQueues: ["main", envMasterQueue],
          reserveConcurrency: {
            messageId: "r1234",
            recursiveQueue: false,
          },
        });

        expect(enqueueResult).toBe(true);

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

        const envReserveConcurrency = await queue.reserveConcurrencyOfEnvironment(
          authenticatedEnvDev
        );
        expect(envReserveConcurrency).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "enqueueMessage with recursive reserved concurrency adds to the environment and queue reserved concurrency",
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
        const enqueueResult = await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          masterQueues: ["main", envMasterQueue],
          reserveConcurrency: {
            messageId: "r1234",
            recursiveQueue: true,
          },
        });

        expect(enqueueResult).toBe(true);

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

        const queueReserveConcurrency = await queue.reserveConcurrencyOfQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(queueReserveConcurrency).toBe(1);

        const envConcurrency = await queue.currentConcurrencyOfEnvironment(authenticatedEnvDev);
        expect(envConcurrency).toBe(0);

        const envReserveConcurrency = await queue.reserveConcurrencyOfEnvironment(
          authenticatedEnvDev
        );
        expect(envReserveConcurrency).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "enqueueMessage of a reserved message should clear the reserved concurrency",
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
        const enqueueResult = await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          masterQueues: ["main", envMasterQueue],
          reserveConcurrency: {
            messageId: "r1234",
            recursiveQueue: false,
          },
        });

        expect(enqueueResult).toBe(true);

        const envReserveConcurrency = await queue.reserveConcurrencyOfEnvironment(
          authenticatedEnvDev
        );
        expect(envReserveConcurrency).toBe(1);

        // enqueue reserve message
        const enqueueResult2 = await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: {
            ...messageDev,
            runId: "r1234",
          },
          masterQueues: ["main", envMasterQueue],
        });

        expect(enqueueResult2).toBe(true);

        const envReserveConcurrencyAfter = await queue.reserveConcurrencyOfEnvironment(
          authenticatedEnvDev
        );
        expect(envReserveConcurrencyAfter).toBe(0);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "enqueueMessage with non-recursive reserved concurrency cannot exceed the environment's maximum concurrency limit",
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
        const envMasterQueue = `env:${authenticatedEnvDev.id}`;

        await queue.updateEnvConcurrencyLimits({
          ...authenticatedEnvDev,
          maximumConcurrencyLimit: 1,
        });

        const envConcurrencyLimit = await queue.getEnvConcurrencyLimit(authenticatedEnvDev);
        expect(envConcurrencyLimit).toBe(1);

        //enqueue message
        const enqueueResult = await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          masterQueues: ["main", envMasterQueue],
          reserveConcurrency: {
            messageId: "r1234",
            recursiveQueue: false,
          },
        });

        expect(enqueueResult).toBe(true);

        const envReserveConcurrency = await queue.reserveConcurrencyOfEnvironment(
          authenticatedEnvDev
        );
        expect(envReserveConcurrency).toBe(1);

        // enqueue another message with a non-recursive reserved concurrency
        const enqueueResult2 = await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: {
            ...messageDev,
            runId: "rabc123",
          },
          masterQueues: ["main", envMasterQueue],
          reserveConcurrency: {
            messageId: "r12345678",
            recursiveQueue: false,
          },
        });

        expect(enqueueResult2).toBe(true);

        const envReserveConcurrencyAfter = await queue.reserveConcurrencyOfEnvironment(
          authenticatedEnvDev
        );
        expect(envReserveConcurrencyAfter).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "enqueueMessage with recursive reserved concurrency should fail if queue reserve concurrency will exceed the queue concurrency limit",
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
        const envMasterQueue = `env:${authenticatedEnvDev.id}`;

        await queue.updateQueueConcurrencyLimits(authenticatedEnvDev, messageDev.queue, 1);

        const envConcurrencyLimit = await queue.getQueueConcurrencyLimit(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(envConcurrencyLimit).toBe(1);

        //enqueue message
        const enqueueResult = await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: messageDev,
          masterQueues: ["main", envMasterQueue],
          reserveConcurrency: {
            messageId: "r1234",
            recursiveQueue: true,
          },
        });

        expect(enqueueResult).toBe(true);

        const queueReserveConcurrency = await queue.reserveConcurrencyOfQueue(
          authenticatedEnvDev,
          messageDev.queue
        );
        expect(queueReserveConcurrency).toBe(1);

        const envReserveConcurrency = await queue.reserveConcurrencyOfEnvironment(
          authenticatedEnvDev
        );
        expect(envReserveConcurrency).toBe(1);

        // enqueue another message with a non-recursive reserved concurrency
        const enqueueResult2 = await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: {
            ...messageDev,
            runId: "rabc123",
          },
          masterQueues: ["main", envMasterQueue],
          reserveConcurrency: {
            messageId: "r12345678",
            recursiveQueue: true,
          },
        });

        expect(enqueueResult2).toBe(false);

        const queueReserveConcurrencyAfter = await queue.reserveConcurrencyOfQueue(
          authenticatedEnvDev,
          messageDev.queue
        );

        expect(queueReserveConcurrencyAfter).toBe(1);

        const envReserveConcurrencyAfter = await queue.reserveConcurrencyOfEnvironment(
          authenticatedEnvDev
        );
        expect(envReserveConcurrencyAfter).toBe(1);

        const lengthOfQueue = await queue.lengthOfQueue(authenticatedEnvDev, messageDev.queue);
        expect(lengthOfQueue).toBe(1);

        const lengthOfEnvQueue = await queue.lengthOfEnvQueue(authenticatedEnvDev);
        expect(lengthOfEnvQueue).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );
});
