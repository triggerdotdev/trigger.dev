import { redisTest, StartedRedisContainer } from "@internal/testcontainers";
import { ReleaseConcurrencyTokenBucketQueue } from "../releaseConcurrencyTokenBucketQueue.js";
import { setTimeout } from "node:timers/promises";

type TestQueueDescriptor = {
  name: string;
};

function createReleaseConcurrencyQueue(
  redisContainer: StartedRedisContainer,
  maxTokens: number = 2
) {
  const executedRuns: { releaseQueue: string; runId: string }[] = [];

  const queue = new ReleaseConcurrencyTokenBucketQueue<TestQueueDescriptor>({
    redis: {
      keyPrefix: "release-queue:test:",
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
    },
    executor: async (releaseQueue, runId) => {
      executedRuns.push({ releaseQueue: releaseQueue.name, runId });
    },
    maxTokens: async (_) => maxTokens,
    keys: {
      fromDescriptor: (descriptor) => descriptor.name,
      toDescriptor: (name) => ({ name }),
    },
    pollInterval: 100,
  });

  return {
    queue,
    executedRuns,
  };
}

describe("ReleaseConcurrencyQueue", () => {
  redisTest("Should manage token bucket and queue correctly", async ({ redisContainer }) => {
    const { queue, executedRuns } = createReleaseConcurrencyQueue(redisContainer, 2);

    try {
      // First two attempts should execute immediately (we have 2 tokens)
      await queue.attemptToRelease({ name: "test-queue" }, "run1");
      await queue.attemptToRelease({ name: "test-queue" }, "run2");

      // Verify first two runs were executed
      expect(executedRuns).toHaveLength(2);
      expect(executedRuns).toContainEqual({ releaseQueue: "test-queue", runId: "run1" });
      expect(executedRuns).toContainEqual({ releaseQueue: "test-queue", runId: "run2" });

      // Third attempt should be queued (no tokens left)
      await queue.attemptToRelease({ name: "test-queue" }, "run3");
      expect(executedRuns).toHaveLength(2); // Still 2, run3 is queued

      // Refill one token, should execute run3
      await queue.refillTokens({ name: "test-queue" }, 1);

      // Now we need to wait for the queue to be processed
      await setTimeout(1000);

      expect(executedRuns).toHaveLength(3);
      expect(executedRuns).toContainEqual({ releaseQueue: "test-queue", runId: "run3" });
    } finally {
      await queue.quit();
    }
  });

  redisTest("Should handle multiple refills correctly", async ({ redisContainer }) => {
    const { queue, executedRuns } = createReleaseConcurrencyQueue(redisContainer, 3);

    try {
      // Queue up 5 runs (more than maxTokens)
      await queue.attemptToRelease({ name: "test-queue" }, "run1");
      await queue.attemptToRelease({ name: "test-queue" }, "run2");
      await queue.attemptToRelease({ name: "test-queue" }, "run3");
      await queue.attemptToRelease({ name: "test-queue" }, "run4");
      await queue.attemptToRelease({ name: "test-queue" }, "run5");

      // First 3 should be executed immediately (maxTokens = 3)
      expect(executedRuns).toHaveLength(3);
      expect(executedRuns).toContainEqual({ releaseQueue: "test-queue", runId: "run1" });
      expect(executedRuns).toContainEqual({ releaseQueue: "test-queue", runId: "run2" });
      expect(executedRuns).toContainEqual({ releaseQueue: "test-queue", runId: "run3" });

      // Refill 2 tokens
      await queue.refillTokens({ name: "test-queue" }, 2);

      await setTimeout(1000);

      // Should execute the remaining 2 runs
      expect(executedRuns).toHaveLength(5);
      expect(executedRuns).toContainEqual({ releaseQueue: "test-queue", runId: "run4" });
      expect(executedRuns).toContainEqual({ releaseQueue: "test-queue", runId: "run5" });
    } finally {
      await queue.quit();
    }
  });

  redisTest("Should handle multiple queues independently", async ({ redisContainer }) => {
    const { queue, executedRuns } = createReleaseConcurrencyQueue(redisContainer, 1);

    try {
      // Add runs to different queues
      await queue.attemptToRelease({ name: "queue1" }, "run1");
      await queue.attemptToRelease({ name: "queue1" }, "run2");
      await queue.attemptToRelease({ name: "queue2" }, "run3");
      await queue.attemptToRelease({ name: "queue2" }, "run4");

      // Only first run from each queue should be executed
      expect(executedRuns).toHaveLength(2);
      expect(executedRuns).toContainEqual({ releaseQueue: "queue1", runId: "run1" });
      expect(executedRuns).toContainEqual({ releaseQueue: "queue2", runId: "run3" });

      // Refill tokens for queue1
      await queue.refillTokens({ name: "queue1" }, 1);

      await setTimeout(1000);

      // Should only execute the queued run from queue1
      expect(executedRuns).toHaveLength(3);
      expect(executedRuns).toContainEqual({ releaseQueue: "queue1", runId: "run2" });

      // Refill tokens for queue2
      await queue.refillTokens({ name: "queue2" }, 1);

      await setTimeout(1000);

      // Should execute the queued run from queue2
      expect(executedRuns).toHaveLength(4);
      expect(executedRuns).toContainEqual({ releaseQueue: "queue2", runId: "run4" });
    } finally {
      await queue.quit();
    }
  });

  redisTest("Should not allow refilling more than maxTokens", async ({ redisContainer }) => {
    const { queue, executedRuns } = createReleaseConcurrencyQueue(redisContainer, 1);

    try {
      // Add two runs
      await queue.attemptToRelease({ name: "test-queue" }, "run1");
      await queue.attemptToRelease({ name: "test-queue" }, "run2");

      // First run should be executed immediately
      expect(executedRuns).toHaveLength(1);
      expect(executedRuns).toContainEqual({ releaseQueue: "test-queue", runId: "run1" });

      // Refill with more tokens than needed
      await queue.refillTokens({ name: "test-queue" }, 5);

      await setTimeout(1000);

      // Should only execute the one remaining run
      expect(executedRuns).toHaveLength(2);
      expect(executedRuns).toContainEqual({ releaseQueue: "test-queue", runId: "run2" });

      // Add another run - should NOT execute immediately because we don't have excess tokens
      await queue.attemptToRelease({ name: "test-queue" }, "run3");
      expect(executedRuns).toHaveLength(2);
    } finally {
      await queue.quit();
    }
  });

  redisTest("Should maintain FIFO order when releasing", async ({ redisContainer }) => {
    const { queue, executedRuns } = createReleaseConcurrencyQueue(redisContainer, 1);

    try {
      // Queue up multiple runs
      await queue.attemptToRelease({ name: "test-queue" }, "run1");
      await queue.attemptToRelease({ name: "test-queue" }, "run2");
      await queue.attemptToRelease({ name: "test-queue" }, "run3");
      await queue.attemptToRelease({ name: "test-queue" }, "run4");

      // First run should be executed immediately
      expect(executedRuns).toHaveLength(1);
      expect(executedRuns[0]).toEqual({ releaseQueue: "test-queue", runId: "run1" });

      // Refill tokens one at a time and verify order
      await queue.refillTokens({ name: "test-queue" }, 1);

      await setTimeout(1000);

      expect(executedRuns).toHaveLength(2);
      expect(executedRuns[1]).toEqual({ releaseQueue: "test-queue", runId: "run2" });

      await queue.refillTokens({ name: "test-queue" }, 1);

      await setTimeout(1000);

      expect(executedRuns).toHaveLength(3);
      expect(executedRuns[2]).toEqual({ releaseQueue: "test-queue", runId: "run3" });

      await queue.refillTokens({ name: "test-queue" }, 1);

      await setTimeout(1000);

      expect(executedRuns).toHaveLength(4);
      expect(executedRuns[3]).toEqual({ releaseQueue: "test-queue", runId: "run4" });
    } finally {
      await queue.quit();
    }
  });

  redisTest(
    "Should handle executor failures by returning the token and adding the item into the queue",
    async ({ redisContainer }) => {
      let shouldFail = true;

      const executedRuns: { releaseQueue: string; runId: string }[] = [];

      const queue = new ReleaseConcurrencyTokenBucketQueue<string>({
        redis: {
          keyPrefix: "release-queue:test:",
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
        },
        executor: async (releaseQueue, runId) => {
          if (shouldFail) {
            throw new Error("Executor failed");
          }
          executedRuns.push({ releaseQueue, runId });
        },
        maxTokens: async (_) => 2,
        keys: {
          fromDescriptor: (descriptor) => descriptor,
          toDescriptor: (name) => name,
        },
        batchSize: 2,
        retry: {
          maxRetries: 2,
          backoff: {
            minDelay: 100,
            maxDelay: 1000,
            factor: 1,
          },
        },
        pollInterval: 50,
      });

      try {
        // Attempt to release with failing executor
        await queue.attemptToRelease("test-queue", "run1");
        // Does not execute because the executor throws an error
        expect(executedRuns).toHaveLength(0);

        // Token should have been returned to the bucket so this should try to execute immediately and fail again
        await queue.attemptToRelease("test-queue", "run2");
        expect(executedRuns).toHaveLength(0);

        // Allow executor to succeed
        shouldFail = false;

        await setTimeout(1000);

        // Should now execute successfully
        expect(executedRuns).toHaveLength(2);
        expect(executedRuns[0]).toEqual({ releaseQueue: "test-queue", runId: "run1" });
        expect(executedRuns[1]).toEqual({ releaseQueue: "test-queue", runId: "run2" });
      } finally {
        await queue.quit();
      }
    }
  );

  redisTest("Should handle invalid token amounts", async ({ redisContainer }) => {
    const { queue, executedRuns } = createReleaseConcurrencyQueue(redisContainer, 1);

    try {
      // Try to refill with negative tokens
      await expect(queue.refillTokens({ name: "test-queue" }, -1)).rejects.toThrow();

      // Try to refill with zero tokens
      await queue.refillTokens({ name: "test-queue" }, 0);

      await setTimeout(1000);

      expect(executedRuns).toHaveLength(0);

      // Verify normal operation still works
      await queue.attemptToRelease({ name: "test-queue" }, "run1");
      expect(executedRuns).toHaveLength(1);
    } finally {
      await queue.quit();
    }
  });

  redisTest("Should handle concurrent operations correctly", async ({ redisContainer }) => {
    const executedRuns: { releaseQueue: string; runId: string }[] = [];

    const queue = new ReleaseConcurrencyTokenBucketQueue<string>({
      redis: {
        keyPrefix: "release-queue:test:",
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
      executor: async (releaseQueue, runId) => {
        // Add small delay to simulate work
        await setTimeout(10);
        executedRuns.push({ releaseQueue, runId });
      },
      keys: {
        fromDescriptor: (descriptor) => descriptor,
        toDescriptor: (name) => name,
      },
      maxTokens: async (_) => 2,
      batchSize: 5,
      pollInterval: 50,
    });

    try {
      // Attempt multiple concurrent releases
      await Promise.all([
        queue.attemptToRelease("test-queue", "run1"),
        queue.attemptToRelease("test-queue", "run2"),
        queue.attemptToRelease("test-queue", "run3"),
        queue.attemptToRelease("test-queue", "run4"),
      ]);

      // Should only execute maxTokens (2) runs
      expect(executedRuns).toHaveLength(2);

      // Attempt concurrent refills
      await queue.refillTokens("test-queue", 2);

      await setTimeout(1000);

      // Should execute remaining runs
      expect(executedRuns).toHaveLength(4);

      // Verify all runs were executed exactly once
      const runCounts = executedRuns.reduce(
        (acc, { runId }) => {
          acc[runId] = (acc[runId] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>
      );

      Object.values(runCounts).forEach((count) => {
        expect(count).toBe(1);
      });
    } finally {
      await queue.quit();
    }
  });

  redisTest("Should clean up Redis resources on quit", async ({ redisContainer }) => {
    const { queue } = createReleaseConcurrencyQueue(redisContainer, 1);

    // Add some data
    await queue.attemptToRelease({ name: "test-queue" }, "run1");
    await queue.attemptToRelease({ name: "test-queue" }, "run2");

    // Quit the queue
    await queue.quit();

    // Verify we can't perform operations after quit
    await expect(queue.attemptToRelease({ name: "test-queue" }, "run3")).rejects.toThrow();
    await expect(queue.refillTokens({ name: "test-queue" }, 1)).rejects.toThrow();
  });

  redisTest("Should stop retrying after max retries is reached", async ({ redisContainer }) => {
    let failCount = 0;
    const executedRuns: { releaseQueue: string; runId: string; attempt: number }[] = [];

    const queue = new ReleaseConcurrencyTokenBucketQueue<string>({
      redis: {
        keyPrefix: "release-queue:test:",
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
      executor: async (releaseQueue, runId) => {
        failCount++;
        executedRuns.push({ releaseQueue, runId, attempt: failCount });
        throw new Error("Executor failed");
      },
      keys: {
        fromDescriptor: (descriptor) => descriptor,
        toDescriptor: (name) => name,
      },
      maxTokens: async (_) => 1,
      retry: {
        maxRetries: 2, // Set max retries to 2 (will attempt 3 times total: initial + 2 retries)
        backoff: {
          minDelay: 100,
          maxDelay: 1000,
          factor: 1,
        },
      },
      pollInterval: 50, // Reduce poll interval for faster test
    });

    try {
      // Attempt to release - this will fail and retry
      await queue.attemptToRelease("test-queue", "run1");

      // Wait for retries to occur
      await setTimeout(2000);

      // Should have attempted exactly 3 times (initial + 2 retries)
      expect(executedRuns).toHaveLength(3);
      expect(executedRuns[0]).toEqual({ releaseQueue: "test-queue", runId: "run1", attempt: 1 });
      expect(executedRuns[1]).toEqual({ releaseQueue: "test-queue", runId: "run1", attempt: 2 });
      expect(executedRuns[2]).toEqual({ releaseQueue: "test-queue", runId: "run1", attempt: 3 });

      // Verify that no more retries occur
      await setTimeout(1000);
      expect(executedRuns).toHaveLength(3); // Should still be 3

      // Attempt a new release to verify the token was returned
      let secondRunAttempted = false;
      const queue2 = new ReleaseConcurrencyTokenBucketQueue<string>({
        redis: {
          keyPrefix: "release-queue:test:",
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
        },
        executor: async (releaseQueue, runId) => {
          secondRunAttempted = true;
        },
        keys: {
          fromDescriptor: (descriptor) => descriptor,
          toDescriptor: (name) => name,
        },
        maxTokens: async (_) => 1,
        retry: {
          maxRetries: 2,
          backoff: {
            minDelay: 100,
            maxDelay: 1000,
            factor: 1,
          },
        },
        pollInterval: 50,
      });

      await queue2.attemptToRelease("test-queue", "run2");
      expect(secondRunAttempted).toBe(true); // Should execute immediately because token was returned

      await queue2.quit();
    } finally {
      await queue.quit();
    }
  });

  redisTest("Should handle max retries in batch processing", async ({ redisContainer }) => {
    const executedRuns: { releaseQueue: string; runId: string; attempt: number }[] = [];
    const runAttempts: Record<string, number> = {};

    const queue = new ReleaseConcurrencyTokenBucketQueue<string>({
      redis: {
        keyPrefix: "release-queue:test:",
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
      executor: async (releaseQueue, runId) => {
        runAttempts[runId] = (runAttempts[runId] || 0) + 1;
        executedRuns.push({ releaseQueue, runId, attempt: runAttempts[runId] });
        throw new Error("Executor failed");
      },
      keys: {
        fromDescriptor: (descriptor) => descriptor,
        toDescriptor: (name) => name,
      },
      maxTokens: async (_) => 3,
      retry: {
        maxRetries: 2,
        backoff: {
          minDelay: 100,
          maxDelay: 1000,
          factor: 1,
        },
      },
      batchSize: 3,
      pollInterval: 100,
    });

    try {
      // Queue up multiple runs
      await Promise.all([
        queue.attemptToRelease("test-queue", "run1"),
        queue.attemptToRelease("test-queue", "run2"),
        queue.attemptToRelease("test-queue", "run3"),
      ]);

      // Wait for all retries to complete
      await setTimeout(2000);

      // Each run should have been attempted exactly 3 times
      expect(Object.values(runAttempts)).toHaveLength(3); // 3 runs
      Object.values(runAttempts).forEach((attempts) => {
        expect(attempts).toBe(3); // Each run attempted 3 times
      });

      // Verify execution order maintained retry attempts for each run
      const run1Attempts = executedRuns.filter((r) => r.runId === "run1");
      const run2Attempts = executedRuns.filter((r) => r.runId === "run2");
      const run3Attempts = executedRuns.filter((r) => r.runId === "run3");

      expect(run1Attempts).toHaveLength(3);
      expect(run2Attempts).toHaveLength(3);
      expect(run3Attempts).toHaveLength(3);

      // Verify attempts are numbered correctly for each run
      [run1Attempts, run2Attempts, run3Attempts].forEach((attempts) => {
        expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
      });

      // Verify no more retries occur
      await setTimeout(1000);
      expect(executedRuns).toHaveLength(9); // 3 runs * 3 attempts each
    } finally {
      await queue.quit();
    }
  });

  redisTest("Should implement exponential backoff between retries", async ({ redisContainer }) => {
    const executionTimes: number[] = [];
    let startTime: number;

    const minDelay = 100;
    const factor = 2;

    const queue = new ReleaseConcurrencyTokenBucketQueue<string>({
      redis: {
        keyPrefix: "release-queue:test:",
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
      },
      executor: async (releaseQueue, runId) => {
        const now = Date.now();
        executionTimes.push(now);
        console.log(`Execution at ${now - startTime}ms from start`);
        throw new Error("Executor failed");
      },
      keys: {
        fromDescriptor: (descriptor) => descriptor,
        toDescriptor: (name) => name,
      },
      maxTokens: async (_) => 1,
      retry: {
        maxRetries: 2,
        backoff: {
          minDelay,
          maxDelay: 1000,
          factor,
        },
      },
      pollInterval: 50,
    });

    try {
      startTime = Date.now();
      await queue.attemptToRelease("test-queue", "run1");

      // Wait for all retries to complete
      await setTimeout(1000);

      // Should have 3 execution times (initial + 2 retries)
      expect(executionTimes).toHaveLength(3);

      const intervals = executionTimes.slice(1).map((time, i) => time - executionTimes[i]);
      console.log("Intervals between retries:", intervals);

      // First retry should be after ~200ms (minDelay + processing overhead)
      const expectedFirstDelay = minDelay * 2; // Account for observed overhead
      expect(intervals[0]).toBeGreaterThanOrEqual(expectedFirstDelay * 0.8);
      expect(intervals[0]).toBeLessThanOrEqual(expectedFirstDelay * 1.5);

      // Second retry should be after ~400ms (first delay * factor)
      const expectedSecondDelay = expectedFirstDelay * factor;
      expect(intervals[1]).toBeGreaterThanOrEqual(expectedSecondDelay * 0.8);
      expect(intervals[1]).toBeLessThanOrEqual(expectedSecondDelay * 1.5);

      // Log expected vs actual delays
      console.log("Expected delays:", { first: expectedFirstDelay, second: expectedSecondDelay });
    } finally {
      await queue.quit();
    }
  });

  redisTest("Should not execute or queue when maxTokens is 0", async ({ redisContainer }) => {
    const { queue, executedRuns } = createReleaseConcurrencyQueue(redisContainer, 0);

    try {
      // Attempt to release with maxTokens of 0
      await queue.attemptToRelease({ name: "test-queue" }, "run1");
      await queue.attemptToRelease({ name: "test-queue" }, "run2");

      // Wait some time to ensure no processing occurs
      await setTimeout(1000);

      // Should not have executed any runs
      expect(executedRuns).toHaveLength(0);
    } finally {
      await queue.quit();
    }
  });

  // Makes sure that the maxTokens is an integer (round down)
  // And if it throws, returns 0
  redisTest("Should handle maxTokens errors", async ({ redisContainer }) => {
    const { queue, executedRuns } = createReleaseConcurrencyQueue(redisContainer, 0.5);

    try {
      // Attempt to release with maxTokens of 0
      await queue.attemptToRelease({ name: "test-queue" }, "run1");
      await queue.attemptToRelease({ name: "test-queue" }, "run2");

      // Wait some time to ensure no processing occurs
      await setTimeout(1000);

      // Should not have executed any runs
      expect(executedRuns).toHaveLength(0);
    } finally {
      await queue.quit();
    }
  });
});
