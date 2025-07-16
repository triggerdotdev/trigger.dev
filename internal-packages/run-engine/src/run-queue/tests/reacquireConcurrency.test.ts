import { assertNonNullable, redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { FairQueueSelectionStrategy } from "../fairQueueSelectionStrategy.js";
import { RunQueue } from "../index.js";
import { RunQueueFullKeyProducer } from "../keyProducer.js";
import { InputPayload } from "../types.js";
import { MessageNotFoundError } from "../errors.js";
import { setTimeout } from "node:timers/promises";
import { Decimal } from "@trigger.dev/database";

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
  concurrencyLimitBurstFactor: new Decimal(2.0),
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

describe("RunQueue.reacquireConcurrency", () => {
  redisTest(
    "It should return true if we can reacquire the concurrency",
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
        await queue.updateEnvConcurrencyLimits({
          ...authenticatedEnvProd,
          maximumConcurrencyLimit: 1,
        });

        await queue.enqueueMessage({
          env: authenticatedEnvProd,
          message: messageProd,
          workerQueue: authenticatedEnvProd.id,
        });

        await setTimeout(1000);

        const message = await queue.dequeueMessageFromWorkerQueue(
          "test_12345",
          authenticatedEnvProd.id
        );
        assertNonNullable(message);

        //concurrencies
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
          1
        );
        expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);

        // First, release the concurrency
        await queue.releaseAllConcurrency(authenticatedEnvProd.organization.id, messageProd.runId);

        //reacquire the concurrency
        const result = await queue.reacquireConcurrency(
          authenticatedEnvProd.organization.id,
          messageProd.runId
        );
        expect(result).toBe(true);

        //concurrencies
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
          1
        );
        expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "It should return true if the run is already being counted as concurrency",
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
        await queue.updateEnvConcurrencyLimits({
          ...authenticatedEnvProd,
          maximumConcurrencyLimit: 1,
        });

        await queue.enqueueMessage({
          env: authenticatedEnvProd,
          message: messageProd,
          workerQueue: authenticatedEnvProd.id,
        });

        await setTimeout(1000);

        const message = await queue.dequeueMessageFromWorkerQueue(
          "test_12345",
          authenticatedEnvProd.id
        );
        assertNonNullable(message);

        //concurrencies
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
          1
        );
        expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);

        //reacquire the concurrency
        const result = await queue.reacquireConcurrency(
          authenticatedEnvProd.organization.id,
          messageProd.runId
        );
        expect(result).toBe(true);

        //concurrencies
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
          1
        );
        expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "It should return true if the run is already being counted as concurrency",
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
        await queue.updateEnvConcurrencyLimits({
          ...authenticatedEnvProd,
          maximumConcurrencyLimit: 1,
        });

        await queue.enqueueMessage({
          env: authenticatedEnvProd,
          message: messageProd,
          workerQueue: authenticatedEnvProd.id,
        });

        await setTimeout(1000);

        const message = await queue.dequeueMessageFromWorkerQueue(
          "test_12345",
          authenticatedEnvProd.id
        );
        assertNonNullable(message);

        //concurrencies
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
          1
        );
        expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);

        //reacquire the concurrency
        const result = await queue.reacquireConcurrency(
          authenticatedEnvProd.organization.id,
          messageProd.runId
        );
        expect(result).toBe(true);

        //concurrencies
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
          1
        );
        expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest(
    "It should false if the run is not in the current concurrency set and there is no capacity in the environment",
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
        await queue.updateEnvConcurrencyLimits({
          ...authenticatedEnvProd,
          maximumConcurrencyLimit: 1,
        });

        await queue.enqueueMessage({
          env: authenticatedEnvProd,
          message: messageProd,
          workerQueue: authenticatedEnvProd.id,
        });

        await setTimeout(1000);

        const message = await queue.dequeueMessageFromWorkerQueue(
          "test_12345",
          authenticatedEnvProd.id
        );
        assertNonNullable(message);
        expect(message.message.runId).toBe(messageProd.runId);

        //concurrencies
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
          1
        );
        expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);

        // Enqueue a second message
        await queue.enqueueMessage({
          env: authenticatedEnvProd,
          message: {
            ...messageProd,
            runId: "r1235",
            queue: "task/my-task-2",
          },
          workerQueue: authenticatedEnvProd.id,
        });

        //reacquire the concurrency
        const result = await queue.reacquireConcurrency(
          authenticatedEnvProd.organization.id,
          "r1235"
        );
        expect(result).toBe(false);

        //concurrencies
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, messageProd.queue)).toBe(
          1
        );
        expect(await queue.currentConcurrencyOfQueue(authenticatedEnvProd, "task/my-task-2")).toBe(
          0
        );
        expect(await queue.currentConcurrencyOfEnvironment(authenticatedEnvProd)).toBe(1);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("It should throw an error if the message is not found", async ({ redisContainer }) => {
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
      await expect(
        queue.reacquireConcurrency(authenticatedEnvProd.organization.id, "r1235")
      ).rejects.toThrow(MessageNotFoundError);
    } finally {
      await queue.quit();
    }
  });
});
