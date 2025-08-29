import { redisTest } from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "node:test";
import { expect } from "vitest";
import { z } from "zod";
import { Worker } from "./worker.js";
import { createRedisClient } from "@internal/redis";

describe("Worker", () => {
  redisTest("Process items that don't throw", { timeout: 30_000 }, async ({ redisContainer }) => {
    const processedItems: number[] = [];
    const worker = new Worker({
      name: "test-worker",
      redisOptions: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      },
      catalog: {
        testJob: {
          schema: z.object({ value: z.number() }),
          visibilityTimeoutMs: 5000,
          retry: { maxAttempts: 3 },
        },
      },
      jobs: {
        testJob: async ({ payload }) => {
          await new Promise((resolve) => setTimeout(resolve, 30)); // Simulate work
          processedItems.push(payload.value);
        },
      },
      concurrency: {
        workers: 2,
        tasksPerWorker: 3,
      },
      logger: new Logger("test", "log"),
    }).start();

    // Enqueue 10 items
    for (let i = 0; i < 10; i++) {
      await worker.enqueue({
        id: `item-${i}`,
        job: "testJob",
        payload: { value: i },
        visibilityTimeoutMs: 5000,
      });
    }

    // Wait for items to be processed
    await new Promise((resolve) => setTimeout(resolve, 2000));

    expect(processedItems.length).toBe(10);
    expect(new Set(processedItems).size).toBe(10); // Ensure all items were processed uniquely
  });

  redisTest(
    "Process items that throw an error",
    { timeout: 30_000 },
    async ({ redisContainer }) => {
      const processedItems: number[] = [];
      const hadAttempt = new Set<string>();

      const worker = new Worker({
        name: "test-worker",
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        catalog: {
          testJob: {
            schema: z.object({ value: z.number() }),
            visibilityTimeoutMs: 5000,
            retry: { maxAttempts: 3, minTimeoutInMs: 10, maxTimeoutInMs: 10 },
          },
        },
        jobs: {
          testJob: async ({ id, payload }) => {
            if (!hadAttempt.has(id)) {
              hadAttempt.add(id);
              throw new Error("Test error");
            }

            await new Promise((resolve) => setTimeout(resolve, 30)); // Simulate work
            processedItems.push(payload.value);
          },
        },
        concurrency: {
          workers: 2,
          tasksPerWorker: 3,
        },
        pollIntervalMs: 50,
        logger: new Logger("test", "error"),
      }).start();

      // Enqueue 10 items
      for (let i = 0; i < 10; i++) {
        await worker.enqueue({
          id: `item-${i}`,
          job: "testJob",
          payload: { value: i },
          visibilityTimeoutMs: 5000,
        });
      }

      // Wait for items to be processed
      await new Promise((resolve) => setTimeout(resolve, 500));

      expect(processedItems.length).toBe(10);
      expect(new Set(processedItems).size).toBe(10); // Ensure all items were processed uniquely
    }
  );

  redisTest(
    "Process an item that permanently fails and ends up in DLQ",
    { timeout: 30_000 },
    async ({ redisContainer }) => {
      const processedItems: number[] = [];
      const failedItemId = "permanent-fail-item";

      const worker = new Worker({
        name: "test-worker",
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        catalog: {
          testJob: {
            schema: z.object({ value: z.number() }),
            visibilityTimeoutMs: 1000,
            retry: { maxAttempts: 3, minTimeoutInMs: 10, maxTimeoutInMs: 50 },
          },
        },
        jobs: {
          testJob: async ({ id, payload }) => {
            if (id === failedItemId) {
              throw new Error("Permanent failure");
            }
            processedItems.push(payload.value);
          },
        },
        concurrency: {
          workers: 1,
          tasksPerWorker: 1,
        },
        pollIntervalMs: 50,
        logger: new Logger("test", "error"),
      }).start();

      // Enqueue the item that will permanently fail
      await worker.enqueue({
        id: failedItemId,
        job: "testJob",
        payload: { value: 999 },
      });

      // Enqueue a normal item
      await worker.enqueue({
        id: "normal-item",
        job: "testJob",
        payload: { value: 1 },
      });

      // Wait for items to be processed and retried
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check that the normal item was processed
      expect(processedItems).toEqual([1]);

      // Check that the failed item is in the DLQ
      const dlqSize = await worker.queue.sizeOfDeadLetterQueue();
      expect(dlqSize).toBe(1);
    }
  );

  redisTest(
    "Redrive an item from DLQ and process it successfully",
    { timeout: 30_000 },
    async ({ redisContainer }) => {
      const processedItems: number[] = [];
      const failedItemId = "fail-then-redrive-item";
      let attemptCount = 0;

      const worker = new Worker({
        name: "test-worker",
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        catalog: {
          testJob: {
            schema: z.object({ value: z.number() }),
            visibilityTimeoutMs: 1000,
            retry: { maxAttempts: 3, minTimeoutInMs: 10, maxTimeoutInMs: 50 },
          },
        },
        jobs: {
          testJob: async ({ id, payload }) => {
            if (id === failedItemId && attemptCount < 3) {
              attemptCount++;
              throw new Error("Temporary failure");
            }
            processedItems.push(payload.value);
          },
        },
        concurrency: {
          workers: 1,
          tasksPerWorker: 1,
        },
        pollIntervalMs: 50,
        logger: new Logger("test", "error"),
      }).start();

      // Enqueue the item that will fail 3 times
      await worker.enqueue({
        id: failedItemId,
        job: "testJob",
        payload: { value: 999 },
      });

      // Wait for the item to be processed and moved to DLQ
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check that the item is in the DLQ
      let dlqSize = await worker.queue.sizeOfDeadLetterQueue();
      expect(dlqSize).toBe(1);

      // Create a Redis client to publish the redrive message
      const redisClient = createRedisClient({
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        password: redisContainer.getPassword(),
      });

      // Publish redrive message
      await redisClient.publish("test-worker:redrive", JSON.stringify({ id: failedItemId }));

      // Wait for the item to be redrived and processed
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Check that the item was processed successfully
      expect(processedItems).toEqual([999]);

      // Check that the DLQ is now empty
      dlqSize = await worker.queue.sizeOfDeadLetterQueue();
      expect(dlqSize).toBe(0);

      await redisClient.quit();
    }
  );

  redisTest(
    "Should process a job with the same ID only once when rescheduled",
    { timeout: 30_000 },
    async ({ redisContainer }) => {
      const processedPayloads: string[] = [];

      const worker = new Worker({
        name: "test-worker",
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        catalog: {
          testJob: {
            schema: z.object({ value: z.string() }),
            visibilityTimeoutMs: 5000,
            retry: { maxAttempts: 3 },
          },
        },
        jobs: {
          testJob: async ({ payload }) => {
            await new Promise((resolve) => setTimeout(resolve, 30)); // Simulate work
            processedPayloads.push(payload.value);
          },
        },
        concurrency: {
          workers: 1,
          tasksPerWorker: 1,
        },
        pollIntervalMs: 10, // Ensure quick polling to detect the scheduled item
        logger: new Logger("test", "log"),
      }).start();

      // Unique ID to use for both enqueues
      const testJobId = "duplicate-job-id";

      // Enqueue the first item immediately
      await worker.enqueue({
        id: testJobId,
        job: "testJob",
        payload: { value: "first-attempt" },
        availableAt: new Date(Date.now() + 50),
      });

      // Enqueue another item with the same ID but scheduled 50ms in the future
      await worker.enqueue({
        id: testJobId,
        job: "testJob",
        payload: { value: "second-attempt" },
        availableAt: new Date(Date.now() + 50),
      });

      // Wait enough time for both jobs to be processed if they were going to be
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Verify that only one job was processed (the second one should have replaced the first)
      expect(processedPayloads.length).toBe(1);

      // Verify that the second job's payload was the one processed
      expect(processedPayloads[0]).toBe("second-attempt");

      await worker.stop();
    }
  );

  redisTest(
    "Should process second job with same ID when enqueued during first job execution with future availableAt",
    { timeout: 30_000 },
    async ({ redisContainer }) => {
      const processedPayloads: string[] = [];
      const jobStarted: string[] = [];
      let firstJobCompleted = false;

      const worker = new Worker({
        name: "test-worker",
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        catalog: {
          testJob: {
            schema: z.object({ value: z.string() }),
            visibilityTimeoutMs: 5000,
            retry: { maxAttempts: 3 },
          },
        },
        jobs: {
          testJob: async ({ payload }) => {
            // Record when the job starts processing
            jobStarted.push(payload.value);

            if (payload.value === "first-attempt") {
              // First job takes a long time to process
              await new Promise((resolve) => setTimeout(resolve, 1_000));
              firstJobCompleted = true;
            }

            // Record when the job completes
            processedPayloads.push(payload.value);
          },
        },
        concurrency: {
          workers: 1,
          tasksPerWorker: 1,
        },
        pollIntervalMs: 10,
        logger: new Logger("test", "log"),
      }).start();

      const testJobId = "long-running-job-id";

      // Queue the first job
      await worker.enqueue({
        id: testJobId,
        job: "testJob",
        payload: { value: "first-attempt" },
      });

      // Verify initial queue size
      const size1 = await worker.queue.size({ includeFuture: true });
      expect(size1).toBe(1);

      // Wait until we know the first job has started processing
      while (jobStarted.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Now that first job is running, queue second job with same ID
      // Set availableAt to be 1.5 seconds in the future (after first job completes)
      await worker.enqueue({
        id: testJobId,
        job: "testJob",
        payload: { value: "second-attempt" },
        availableAt: new Date(Date.now() + 1500),
      });

      // Verify queue size after second enqueue
      const size2 = await worker.queue.size({ includeFuture: true });
      const size2Present = await worker.queue.size({ includeFuture: false });
      expect(size2).toBe(1); // Should still be 1 as it's the same ID

      // Wait for the first job to complete
      while (!firstJobCompleted) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      // Check queue size right after first job completes
      const size3 = await worker.queue.size({ includeFuture: true });
      const size3Present = await worker.queue.size({ includeFuture: false });

      // Wait long enough for the second job to become available and potentially run
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Final queue size
      const size4 = await worker.queue.size({ includeFuture: true });
      const size4Present = await worker.queue.size({ includeFuture: false });

      // First job should have run
      expect(processedPayloads).toContain("first-attempt");

      // These assertions should fail - demonstrating the bug
      // The second job should run after its availableAt time, but doesn't because
      // the ack from the first job removed it from Redis entirely
      expect(jobStarted).toContain("second-attempt");
      expect(processedPayloads).toContain("second-attempt");
      expect(processedPayloads.length).toBe(2);

      await worker.stop();
    }
  );

  redisTest(
    "Should properly remove future-scheduled job after completion",
    { timeout: 30_000 },
    async ({ redisContainer }) => {
      const processedPayloads: string[] = [];

      const worker = new Worker({
        name: "test-worker",
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        catalog: {
          testJob: {
            schema: z.object({ value: z.string() }),
            visibilityTimeoutMs: 5000,
            retry: { maxAttempts: 3 },
          },
        },
        jobs: {
          testJob: async ({ payload }) => {
            processedPayloads.push(payload.value);
          },
        },
        concurrency: {
          workers: 1,
          tasksPerWorker: 1,
        },
        pollIntervalMs: 10,
        logger: new Logger("test", "debug"), // Use debug to see all logs
      }).start();

      // Schedule a job 500ms in the future
      await worker.enqueue({
        id: "future-job",
        job: "testJob",
        payload: { value: "test" },
        availableAt: new Date(Date.now() + 500),
      });

      // Verify it's in the future queue
      const initialSize = await worker.queue.size();
      const initialSizeWithFuture = await worker.queue.size({ includeFuture: true });
      expect(initialSize).toBe(0);
      expect(initialSizeWithFuture).toBe(1);

      // Wait for job to be processed
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify job was processed
      expect(processedPayloads).toContain("test");

      // Verify queue is completely empty
      const finalSize = await worker.queue.size();
      const finalSizeWithFuture = await worker.queue.size({ includeFuture: true });
      expect(finalSize).toBe(0);
      expect(finalSizeWithFuture).toBe(0);

      await worker.stop();
    }
  );

  redisTest(
    "Should properly remove immediate job after completion",
    { timeout: 30_000 },
    async ({ redisContainer }) => {
      const processedPayloads: string[] = [];

      const worker = new Worker({
        name: "test-worker",
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        catalog: {
          testJob: {
            schema: z.object({ value: z.string() }),
            visibilityTimeoutMs: 5000,
            retry: { maxAttempts: 3 },
          },
        },
        jobs: {
          testJob: async ({ payload }) => {
            processedPayloads.push(payload.value);
          },
        },
        concurrency: {
          workers: 1,
          tasksPerWorker: 1,
        },
        pollIntervalMs: 10,
        logger: new Logger("test", "debug"), // Use debug to see all logs
      }).start();

      // Enqueue a job to run immediately
      await worker.enqueue({
        id: "immediate-job",
        job: "testJob",
        payload: { value: "test" },
      });

      // Verify it's in the present queue
      const initialSize = await worker.queue.size();
      const initialSizeWithFuture = await worker.queue.size({ includeFuture: true });
      expect(initialSize).toBe(1);
      expect(initialSizeWithFuture).toBe(1);

      // Wait for job to be processed
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify job was processed
      expect(processedPayloads).toContain("test");

      // Verify queue is completely empty
      const finalSize = await worker.queue.size();
      const finalSizeWithFuture = await worker.queue.size({ includeFuture: true });
      expect(finalSize).toBe(0);
      expect(finalSizeWithFuture).toBe(0);

      await worker.stop();
    }
  );

  redisTest(
    "Should allow cancelling a job before it's enqueued, but only if the enqueue.cancellationKey is provided",
    { timeout: 30_000 },
    async ({ redisContainer }) => {
      const processedPayloads: string[] = [];

      const worker = new Worker({
        name: "test-worker",
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        catalog: {
          testJob: {
            schema: z.object({ value: z.string() }),
            visibilityTimeoutMs: 5000,
            retry: { maxAttempts: 3 },
          },
        },
        jobs: {
          testJob: async ({ payload }) => {
            processedPayloads.push(payload.value);
          },
        },
        concurrency: {
          workers: 1,
          tasksPerWorker: 1,
        },
        pollIntervalMs: 10,
        logger: new Logger("test", "debug"), // Use debug to see all logs
      }).start();

      // Enqueue a job to run immediately
      await worker.enqueue({
        id: "immediate-job",
        job: "testJob",
        payload: { value: "test" },
        cancellationKey: "test-cancellation-key",
      });

      // Verify it's in the present queue
      const initialSize = await worker.queue.size();
      const initialSizeWithFuture = await worker.queue.size({ includeFuture: true });
      expect(initialSize).toBe(1);
      expect(initialSizeWithFuture).toBe(1);

      // Wait for job to be processed
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Verify job was processed
      expect(processedPayloads).toContain("test");

      // Verify queue is completely empty
      const finalSize = await worker.queue.size();
      const finalSizeWithFuture = await worker.queue.size({ includeFuture: true });
      expect(finalSize).toBe(0);
      expect(finalSizeWithFuture).toBe(0);

      // Now cancel a key
      await worker.cancel("test-cancellation-key-2");

      await worker.enqueue({
        id: "immediate-job",
        job: "testJob",
        payload: { value: "test" },
        cancellationKey: "test-cancellation-key-2",
      });

      // Verify it's not in the queue (since it's been cancelled)
      const finalSize2 = await worker.queue.size();
      expect(finalSize2).toBe(0);
      const finalSize2WithFuture = await worker.queue.size({ includeFuture: true });
      expect(finalSize2WithFuture).toBe(0);

      await worker.stop();
    }
  );
});
