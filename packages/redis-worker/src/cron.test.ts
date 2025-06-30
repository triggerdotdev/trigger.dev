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

      expect(processedItems.length).toBe(2);

      const secondItem = processedItems[1];
      expect(secondItem?.timestamp).toBeGreaterThan(firstItem!.timestamp);
      expect(secondItem?.lastTimestamp).toBe(firstItem?.timestamp);
      expect(secondItem?.cron).toBe("*/5 * * * * *");

      await worker.stop();
    }
  );
});
