import { redisTest } from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "node:test";
import { expect } from "vitest";
import { z } from "zod";
import { Worker } from "./worker.js";
import Redis from "ioredis";
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

    try {
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
    } finally {
      worker.stop();
    }
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

      try {
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
      } finally {
        worker.stop();
      }
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

      try {
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
      } finally {
        worker.stop();
      }
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

      try {
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
      } finally {
        worker.stop();
      }
    }
  );
});
