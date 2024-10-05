import { redisTest } from "@internal/testcontainers";
import { describe, it } from "node:test";
import { expect } from "vitest";
import { z } from "zod";
import { Worker } from "./worker.js";
import { Logger } from "@trigger.dev/core/logger";
import { SimpleQueue } from "./queue.js";

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

    worker.stop();

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
            retry: { maxAttempts: 3, minDelayMs: 10 },
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

      worker.stop();

      expect(processedItems.length).toBe(10);
      expect(new Set(processedItems).size).toBe(10); // Ensure all items were processed uniquely
    }
  );
});

//todo test throwing an error and that retrying works
//todo test that throwing an error doesn't screw up the other items
//todo change the processItems to be in parallel using Promise.allResolved
//process more items when finished
