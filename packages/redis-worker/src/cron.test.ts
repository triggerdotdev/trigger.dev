import { redisTest } from "@internal/testcontainers";
import { Logger } from "@trigger.dev/core/logger";
import { describe } from "node:test";
import { expect } from "vitest";
import { Worker, CronSchema } from "./worker.js";
import { setTimeout } from "node:timers/promises";

describe("Worker with cron", () => {
  redisTest(
    "process items on the cron schedule",
    { timeout: 180_000 },
    async ({ redisContainer }) => {
      const processedItems: CronSchema[] = [];
      const worker = new Worker({
        name: "test-worker",
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        catalog: {
          cronJob: {
            cron: "*/5 * * * * *", // Every 5 seconds
            schema: CronSchema,
            visibilityTimeoutMs: 5000,
            retry: { maxAttempts: 3 },
            jitter: 100,
          },
        },
        jobs: {
          cronJob: async ({ payload }) => {
            await setTimeout(30); // Simulate work
            processedItems.push(payload);
          },
        },
        concurrency: {
          workers: 2,
          tasksPerWorker: 3,
        },
        logger: new Logger("test", "debug"),
      }).start();

      await setTimeout(6_000);

      expect(processedItems.length).toBe(1);

      const firstItem = processedItems[0];

      expect(firstItem?.timestamp).toBeGreaterThan(0);
      expect(firstItem?.lastTimestamp).toBeUndefined();
      expect(firstItem?.cron).toBe("*/5 * * * * *");

      await setTimeout(6_000);

      expect(processedItems.length).toBeGreaterThanOrEqual(2);

      const secondItem = processedItems[1];
      expect(secondItem?.timestamp).toBeGreaterThan(firstItem!.timestamp);
      expect(secondItem?.lastTimestamp).toBe(firstItem?.timestamp);
      expect(secondItem?.cron).toBe("*/5 * * * * *");

      await worker.stop();
    }
  );

  redisTest(
    "continues processing cron items even when job handler throws errors",
    { timeout: 180_000 },
    async ({ redisContainer }) => {
      const processedItems: CronSchema[] = [];
      let executionCount = 0;

      const worker = new Worker({
        name: "test-worker-error",
        redisOptions: {
          host: redisContainer.getHost(),
          port: redisContainer.getPort(),
          password: redisContainer.getPassword(),
        },
        catalog: {
          cronJob: {
            cron: "*/3 * * * * *", // Every 3 seconds
            schema: CronSchema,
            visibilityTimeoutMs: 5000,
            retry: { maxAttempts: 1 }, // Only try once to fail faster
            jitter: 100,
          },
        },
        jobs: {
          cronJob: async ({ payload }) => {
            executionCount++;
            await setTimeout(30); // Simulate work

            // Throw error on first and third execution
            if (executionCount === 1 || executionCount === 3) {
              throw new Error(`Simulated error on execution ${executionCount}`);
            }

            processedItems.push(payload);
          },
        },
        concurrency: {
          workers: 2,
          tasksPerWorker: 3,
        },
        logger: new Logger("test", "debug"),
      }).start();

      // Wait long enough for 4 executions (12 seconds + buffer)
      await setTimeout(14_000);

      // Should have at least 4 executions total
      expect(executionCount).toBeGreaterThanOrEqual(4);

      // Should have 2 successful items (executions 2 and 4)
      expect(processedItems.length).toBeGreaterThanOrEqual(2);

      // Verify that some executions failed (execution count > successful count)
      // This proves that errors occurred but cron scheduling continued
      expect(executionCount).toBeGreaterThan(processedItems.length);

      // Verify that successful executions still have correct structure
      const firstSuccessful = processedItems[0];
      expect(firstSuccessful?.timestamp).toBeGreaterThan(0);
      expect(firstSuccessful?.cron).toBe("*/3 * * * * *");

      await worker.stop();
    }
  );
});
