import { redisTest } from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "node:test";
import { expect } from "vitest";
import { z } from "zod";
import { Worker } from "./worker.js";

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
    });
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

      worker.start();

      // Wait for items to be processed
      await new Promise((resolve) => setTimeout(resolve, 600));

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
      });

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

        worker.start();

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
      });

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

        worker.start();

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

  //todo test that throwing an error doesn't screw up the other items
  //todo process more items when finished

  //todo add a Dead Letter Queue when items are failed, with the error
  //todo add a function on the worker to redrive them
  //todo add an API endpoint to redrive with an ID
});
