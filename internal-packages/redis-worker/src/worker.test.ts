import { redisTest } from "@internal/testcontainers";
import { describe, it } from "node:test";
import { expect } from "vitest";
import { z } from "zod";
import { Worker } from "./worker.js";
import { Logger } from "@trigger.dev/core/logger";
import { SimpleQueue } from "./queue.js";

describe("Worker", () => {
  // Tests will be added here
});

redisTest("concurrency settings", { timeout: 30_000 }, async ({ redisContainer }) => {
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
