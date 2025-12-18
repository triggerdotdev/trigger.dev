import { assertNonNullable, redisTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { describe, expect, vi } from "vitest";
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

function createMessage(
  runId: string,
  queue: string = "task/my-task",
  rateLimitKey?: string
): InputPayload {
  return {
    runId,
    taskIdentifier: "task/my-task",
    orgId: "o1234",
    projectId: "p1234",
    environmentId: "e1234",
    environmentType: "DEVELOPMENT",
    queue,
    timestamp: Date.now(),
    attempt: 0,
    rateLimitKey,
  };
}

vi.setConfig({ testTimeout: 60_000 });

describe("RunQueue rate limiting", () => {
  redisTest(
    "basic rate limiting - respects limit when config exists",
    async ({ redisContainer }) => {
      const queue = new RunQueue({
        ...testOptions,
        queueSelectionStrategy: new FairQueueSelectionStrategy({
          redis: {
            keyPrefix: "runqueue:rl-test-basic:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
          keys: testOptions.keys,
        }),
        redis: {
          keyPrefix: "runqueue:rl-test-basic:",
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
        },
      });

      try {
        // Set rate limit: 2 per 10 minutes (emissionInterval = 300000ms = 5 min)
        // Using a long period ensures rate limit doesn't recover during test execution
        await queue.setQueueRateLimitConfig(authenticatedEnvDev, "task/my-task", {
          limit: 2,
          periodMs: 600000, // 10 minutes
          burst: 2,
        });

        // Enqueue 5 messages
        for (let i = 0; i < 5; i++) {
          await queue.enqueueMessage({
            env: authenticatedEnvDev,
            message: createMessage(`run-${i}`),
            workerQueue: authenticatedEnvDev.id,
          });
        }

        await setTimeout(500);

        // Note: We don't verify initial queue length here because the background worker
        // may have already started processing. The important test is rate limiting behavior.

        // Dequeue multiple times - with burst=2, only 2 should pass per burst window
        const dequeued: (unknown | undefined)[] = [];
        for (let i = 0; i < 5; i++) {
          const msg = await queue.dequeueMessageFromWorkerQueue(
            `test_rl_${i}`,
            authenticatedEnvDev.id
          );
          dequeued.push(msg);
        }

        // Count how many were actually dequeued vs rate-limited
        const dequeuedCount = dequeued.filter((d) => d !== undefined).length;
        const rateLimitedCount = dequeued.filter((d) => d === undefined).length;

        // With burst=2 and 5 messages, at most 2 should be dequeued immediately
        // (the exact count may vary due to background worker timing, but rate limiting should be active)
        expect(dequeuedCount).toBeLessThanOrEqual(2);
        expect(rateLimitedCount).toBeGreaterThanOrEqual(3);

        // Concurrency should not exceed burst limit
        const concurrency = await queue.currentConcurrencyOfQueue(
          authenticatedEnvDev,
          "task/my-task"
        );
        expect(concurrency).toBeLessThanOrEqual(2);

        // Rate-limited messages should still be in queue (rescheduled for later)
        const remainingLength = await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task");
        expect(remainingLength).toBeGreaterThan(0);
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("rate limiting disabled - all messages dequeued", async ({ redisContainer }) => {
    const queue = new RunQueue({
      ...testOptions,
      disableRateLimits: true, // Rate limiting disabled
      queueSelectionStrategy: new FairQueueSelectionStrategy({
        redis: {
          keyPrefix: "runqueue:rl-test-disabled:",
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
        },
        keys: testOptions.keys,
      }),
      redis: {
        keyPrefix: "runqueue:rl-test-disabled:",
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
    });

    try {
      // Set strict rate limit: 1 per minute
      await queue.setQueueRateLimitConfig(authenticatedEnvDev, "task/my-task", {
        limit: 1,
        periodMs: 60000,
        burst: 1,
      });

      // Enqueue 3 messages
      for (let i = 0; i < 3; i++) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: createMessage(`run-disabled-${i}`),
          workerQueue: authenticatedEnvDev.id,
        });
      }

      await setTimeout(500);

      // All should be dequeued since rate limiting is disabled
      const dequeued1 = await queue.dequeueMessageFromWorkerQueue(
        "test_disabled_1",
        authenticatedEnvDev.id
      );
      const dequeued2 = await queue.dequeueMessageFromWorkerQueue(
        "test_disabled_2",
        authenticatedEnvDev.id
      );
      const dequeued3 = await queue.dequeueMessageFromWorkerQueue(
        "test_disabled_3",
        authenticatedEnvDev.id
      );

      expect(dequeued1).not.toBeUndefined();
      expect(dequeued2).not.toBeUndefined();
      expect(dequeued3).not.toBeUndefined();

      // All should be processed (concurrency = 3)
      const concurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        "task/my-task"
      );
      expect(concurrency).toBe(3);
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "per-key rate limiting - separate buckets per rateLimitKey",
    async ({ redisContainer }) => {
      const queue = new RunQueue({
        ...testOptions,
        queueSelectionStrategy: new FairQueueSelectionStrategy({
          redis: {
            keyPrefix: "runqueue:rl-test-perkey:",
            host: redisContainer.getHost(),
            port: redisContainer.getPort(),
          },
          keys: testOptions.keys,
        }),
        redis: {
          keyPrefix: "runqueue:rl-test-perkey:",
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
        },
      });

      try {
        // Set rate limit: 1 per minute with burst of 1
        await queue.setQueueRateLimitConfig(authenticatedEnvDev, "task/my-task", {
          limit: 1,
          periodMs: 60000,
          burst: 1,
        });

        // Enqueue 2 messages for tenant-A
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: createMessage("run-a1", "task/my-task", "tenant-A"),
          workerQueue: authenticatedEnvDev.id,
        });
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: createMessage("run-a2", "task/my-task", "tenant-A"),
          workerQueue: authenticatedEnvDev.id,
        });

        // Enqueue 2 messages for tenant-B
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: createMessage("run-b1", "task/my-task", "tenant-B"),
          workerQueue: authenticatedEnvDev.id,
        });
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: createMessage("run-b2", "task/my-task", "tenant-B"),
          workerQueue: authenticatedEnvDev.id,
        });

        await setTimeout(500);

        // Dequeue all available
        const dequeued1 = await queue.dequeueMessageFromWorkerQueue(
          "test_perkey_1",
          authenticatedEnvDev.id
        );
        const dequeued2 = await queue.dequeueMessageFromWorkerQueue(
          "test_perkey_2",
          authenticatedEnvDev.id
        );
        const dequeued3 = await queue.dequeueMessageFromWorkerQueue(
          "test_perkey_3",
          authenticatedEnvDev.id
        );
        const dequeued4 = await queue.dequeueMessageFromWorkerQueue(
          "test_perkey_4",
          authenticatedEnvDev.id
        );

        // Should get 2 messages (1 from each tenant, since each has independent bucket)
        const successfulDequeues = [dequeued1, dequeued2, dequeued3, dequeued4].filter(
          (d) => d !== undefined
        );
        expect(successfulDequeues.length).toBe(2);

        // Verify we got one from each tenant
        const rateLimitKeys = successfulDequeues.map((d) => d!.message.rateLimitKey);
        expect(rateLimitKeys).toContain("tenant-A");
        expect(rateLimitKeys).toContain("tenant-B");
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("no rate limit config - all messages dequeued normally", async ({ redisContainer }) => {
    const queue = new RunQueue({
      ...testOptions,
      queueSelectionStrategy: new FairQueueSelectionStrategy({
        redis: {
          keyPrefix: "runqueue:rl-test-noconfig:",
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
        },
        keys: testOptions.keys,
      }),
      redis: {
        keyPrefix: "runqueue:rl-test-noconfig:",
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
    });

    try {
      // No rate limit config set

      // Enqueue 5 messages
      for (let i = 0; i < 5; i++) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: createMessage(`run-noconfig-${i}`),
          workerQueue: authenticatedEnvDev.id,
        });
      }

      await setTimeout(500);

      // All should be dequeued
      const dequeued = [];
      for (let i = 0; i < 5; i++) {
        const d = await queue.dequeueMessageFromWorkerQueue(
          `test_noconfig_${i}`,
          authenticatedEnvDev.id
        );
        if (d) dequeued.push(d);
      }

      expect(dequeued.length).toBe(5);
    } finally {
      await queue.quit();
    }
  });

  redisTest("rate-limited messages do not increment concurrency", async ({ redisContainer }) => {
    const queue = new RunQueue({
      ...testOptions,
      queueSelectionStrategy: new FairQueueSelectionStrategy({
        redis: {
          keyPrefix: "runqueue:rl-test-concurrency:",
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
        },
        keys: testOptions.keys,
      }),
      redis: {
        keyPrefix: "runqueue:rl-test-concurrency:",
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
    });

    try {
      // Set strict rate limit: 1 per minute, burst 1
      await queue.setQueueRateLimitConfig(authenticatedEnvDev, "task/my-task", {
        limit: 1,
        periodMs: 60000,
        burst: 1,
      });

      // Initial concurrency should be 0
      const initialConcurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        "task/my-task"
      );
      expect(initialConcurrency).toBe(0);

      // Enqueue 3 messages
      for (let i = 0; i < 3; i++) {
        await queue.enqueueMessage({
          env: authenticatedEnvDev,
          message: createMessage(`run-conc-${i}`),
          workerQueue: authenticatedEnvDev.id,
        });
      }

      await setTimeout(500);

      // Try to dequeue multiple times
      await queue.dequeueMessageFromWorkerQueue("test_conc_1", authenticatedEnvDev.id);
      await queue.dequeueMessageFromWorkerQueue("test_conc_2", authenticatedEnvDev.id);
      await queue.dequeueMessageFromWorkerQueue("test_conc_3", authenticatedEnvDev.id);

      // Only 1 should have passed rate limit, so concurrency should be 1
      const finalConcurrency = await queue.currentConcurrencyOfQueue(
        authenticatedEnvDev,
        "task/my-task"
      );
      expect(finalConcurrency).toBe(1);

      // Queue should still have 2 messages (rescheduled for later)
      const queueLength = await queue.lengthOfQueue(authenticatedEnvDev, "task/my-task");
      expect(queueLength).toBe(2);
    } finally {
      await queue.quit();
    }
  });
});
