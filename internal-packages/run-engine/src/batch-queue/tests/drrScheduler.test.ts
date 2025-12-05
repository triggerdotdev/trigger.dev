import { redisTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { DRRScheduler } from "../drrScheduler.js";
import { BatchQueueFullKeyProducer } from "../keyProducer.js";
import { createRedisClient } from "@internal/redis";

vi.setConfig({ testTimeout: 60_000 });

describe("DRRScheduler", () => {
  const keys = new BatchQueueFullKeyProducer();

  function createScheduler(redisContainer: { getHost: () => string; getPort: () => number }) {
    return new DRRScheduler({
      redis: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        keyPrefix: "test:",
      },
      keys,
      config: {
        quantum: 5,
        maxDeficit: 50,
      },
    });
  }

  async function setupRedisWithBatch(
    redisContainer: { getHost: () => string; getPort: () => number },
    batchId: string,
    envId: string,
    itemCount: number
  ) {
    const redis = createRedisClient({
      host: redisContainer.getHost(),
      port: redisContainer.getPort(),
      keyPrefix: "test:",
    });

    const now = Date.now();

    // Set up batch metadata
    const meta = {
      batchId,
      friendlyId: `friendly_${batchId}`,
      environmentId: envId,
      environmentType: "DEVELOPMENT",
      organizationId: "org123",
      projectId: "proj123",
      runCount: itemCount,
      createdAt: now,
    };
    await redis.set(keys.batchMetaKey(batchId), JSON.stringify(meta));

    // Add items to batch queue and items hash
    for (let i = 0; i < itemCount; i++) {
      const item = { task: `task-${i}`, payload: `payload-${i}` };
      await redis.hset(keys.batchItemsKey(batchId), i.toString(), JSON.stringify(item));
      await redis.zadd(keys.batchQueueKey(batchId), i, i.toString());
    }

    // Add batch to master queue (member is "{envId}:{batchId}")
    const member = keys.masterQueueMember(envId, batchId);
    await redis.zadd(keys.masterQueueKey(), now, member);

    await redis.quit();
    return meta;
  }

  describe("getBatches", () => {
    redisTest("should return empty array when no batches", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        const batches = await scheduler.getBatches();
        expect(batches).toEqual([]);
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should return batches with envId and batchId", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        await setupRedisWithBatch(redisContainer, "batch1", "env1", 5);
        await setupRedisWithBatch(redisContainer, "batch2", "env2", 3);

        const batches = await scheduler.getBatches();
        expect(batches).toHaveLength(2);
        expect(batches).toContainEqual({ envId: "env1", batchId: "batch1" });
        expect(batches).toContainEqual({ envId: "env2", batchId: "batch2" });
      } finally {
        await scheduler.close();
      }
    });
  });

  describe("getActiveEnvironments", () => {
    redisTest("should return unique environments", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        await setupRedisWithBatch(redisContainer, "batch1", "env1", 5);
        await setupRedisWithBatch(redisContainer, "batch2", "env1", 3); // Same env
        await setupRedisWithBatch(redisContainer, "batch3", "env2", 2);

        const envs = await scheduler.getActiveEnvironments();
        expect(envs).toHaveLength(2);
        expect(envs).toContain("env1");
        expect(envs).toContain("env2");
      } finally {
        await scheduler.close();
      }
    });
  });

  describe("deficit management", () => {
    redisTest("should start with zero deficit", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        const deficit = await scheduler.getDeficit("env1");
        expect(deficit).toBe(0);
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should add quantum to deficit", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        const newDeficit = await scheduler.addQuantum("env1");
        expect(newDeficit).toBe(5); // quantum = 5
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should accumulate deficit", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        await scheduler.addQuantum("env1");
        const newDeficit = await scheduler.addQuantum("env1");
        expect(newDeficit).toBe(10);
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should cap deficit at maxDeficit", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        // Add quantum 11 times (5 * 11 = 55 > maxDeficit of 50)
        for (let i = 0; i < 11; i++) {
          await scheduler.addQuantum("env1");
        }
        const deficit = await scheduler.getDeficit("env1");
        expect(deficit).toBe(50);
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should decrement deficit", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        await scheduler.addQuantum("env1"); // deficit = 5
        const newDeficit = await scheduler.decrementDeficit("env1");
        expect(newDeficit).toBe(4);
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should not go below zero on decrement", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        const deficit = await scheduler.decrementDeficit("env1");
        expect(deficit).toBe(0);
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should reset deficit", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        await scheduler.addQuantum("env1");
        await scheduler.resetDeficit("env1");
        const deficit = await scheduler.getDeficit("env1");
        expect(deficit).toBe(0);
      } finally {
        await scheduler.close();
      }
    });
  });

  describe("batch operations", () => {
    redisTest("should get batch metadata", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        await setupRedisWithBatch(redisContainer, "batch1", "env1", 5);

        const meta = await scheduler.getBatchMeta("batch1");
        expect(meta).not.toBeNull();
        expect(meta?.batchId).toBe("batch1");
        expect(meta?.environmentId).toBe("env1");
        expect(meta?.runCount).toBe(5);
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should check if environment has batches", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        expect(await scheduler.envHasBatches("env1")).toBe(false);

        await setupRedisWithBatch(redisContainer, "batch1", "env1", 5);
        expect(await scheduler.envHasBatches("env1")).toBe(true);
      } finally {
        await scheduler.close();
      }
    });
  });

  describe("dequeueItem", () => {
    redisTest("should dequeue item from batch", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        await setupRedisWithBatch(redisContainer, "batch1", "env1", 3);

        const result = await scheduler.dequeueItem("batch1", "env1");
        expect(result).not.toBeNull();
        expect(result?.itemIndex).toBe(0);
        expect(result?.item.task).toBe("task-0");
        expect(result?.isBatchComplete).toBe(false);
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should mark batch complete on last item", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        await setupRedisWithBatch(redisContainer, "batch1", "env1", 2);

        // Dequeue first item
        const result1 = await scheduler.dequeueItem("batch1", "env1");
        expect(result1?.isBatchComplete).toBe(false);

        // Dequeue second (last) item
        const result2 = await scheduler.dequeueItem("batch1", "env1");
        expect(result2?.isBatchComplete).toBe(true);
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should return null for empty batch", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        await setupRedisWithBatch(redisContainer, "batch1", "env1", 1);

        // Dequeue the only item
        await scheduler.dequeueItem("batch1", "env1");

        // Try to dequeue again
        const result = await scheduler.dequeueItem("batch1", "env1");
        expect(result).toBeNull();
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should remove batch from master queue when empty", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        await setupRedisWithBatch(redisContainer, "batch1", "env1", 1);

        // Verify batch is in master queue
        let batches = await scheduler.getBatches();
        expect(batches).toHaveLength(1);

        // Dequeue the only item (should remove from master queue)
        const result = await scheduler.dequeueItem("batch1", "env1");
        expect(result?.isBatchComplete).toBe(true);

        // Master queue should be empty
        batches = await scheduler.getBatches();
        expect(batches).toHaveLength(0);
      } finally {
        await scheduler.close();
      }
    });
  });

  describe("success/failure tracking", () => {
    redisTest("should record successful runs", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        await setupRedisWithBatch(redisContainer, "batch1", "env1", 3);

        await scheduler.recordSuccess("batch1", "run_1");
        await scheduler.recordSuccess("batch1", "run_2");

        const runs = await scheduler.getSuccessfulRuns("batch1");
        expect(runs).toEqual(["run_1", "run_2"]);
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should record failures", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        await setupRedisWithBatch(redisContainer, "batch1", "env1", 3);

        await scheduler.recordFailure("batch1", {
          index: 0,
          taskIdentifier: "task-0",
          payload: "payload-0",
          error: "Something went wrong",
          errorCode: "TASK_ERROR",
        });

        const failures = await scheduler.getFailures("batch1");
        expect(failures).toHaveLength(1);
        expect(failures[0].index).toBe(0);
        expect(failures[0].error).toBe("Something went wrong");
        expect(failures[0].errorCode).toBe("TASK_ERROR");
        expect(failures[0].timestamp).toBeDefined();
      } finally {
        await scheduler.close();
      }
    });
  });

  describe("cleanup", () => {
    redisTest("should clean up batch data", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        await setupRedisWithBatch(redisContainer, "batch1", "env1", 3);
        await scheduler.recordSuccess("batch1", "run_1");
        await scheduler.recordFailure("batch1", {
          index: 1,
          taskIdentifier: "task-1",
          error: "Error",
        });

        // Verify data exists
        expect(await scheduler.getBatchMeta("batch1")).not.toBeNull();
        expect(await scheduler.getSuccessfulRuns("batch1")).toHaveLength(1);
        expect(await scheduler.getFailures("batch1")).toHaveLength(1);

        // Clean up
        await scheduler.cleanupBatch("batch1");

        // Verify data is gone
        expect(await scheduler.getBatchMeta("batch1")).toBeNull();
        expect(await scheduler.getSuccessfulRuns("batch1")).toHaveLength(0);
        expect(await scheduler.getFailures("batch1")).toHaveLength(0);
      } finally {
        await scheduler.close();
      }
    });
  });

  describe("performDRRIteration", () => {
    redisTest("should return empty when no batches", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        const results = await scheduler.performDRRIteration();
        expect(results).toEqual([]);
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should process items from single batch", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        await setupRedisWithBatch(redisContainer, "batch1", "env1", 10);

        const results = await scheduler.performDRRIteration();
        // Should process up to quantum (5) items
        expect(results.length).toBeGreaterThan(0);
        expect(results.length).toBeLessThanOrEqual(5);

        // All results should be from env1/batch1
        for (const result of results) {
          expect(result.envId).toBe("env1");
          expect(result.batchId).toBe("batch1");
        }
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should distribute fairly across environments", async ({ redisContainer }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        // Set up two environments with batches
        await setupRedisWithBatch(redisContainer, "batch1", "env1", 100);
        await setupRedisWithBatch(redisContainer, "batch2", "env2", 100);

        // Run multiple iterations
        const env1Items: number[] = [];
        const env2Items: number[] = [];

        for (let i = 0; i < 10; i++) {
          const results = await scheduler.performDRRIteration();
          for (const result of results) {
            if (result.envId === "env1") env1Items.push(result.itemIndex);
            if (result.envId === "env2") env2Items.push(result.itemIndex);
          }
        }

        // Both environments should have received items (fair distribution)
        expect(env1Items.length).toBeGreaterThan(0);
        expect(env2Items.length).toBeGreaterThan(0);

        // Distribution should be roughly equal (within 2x)
        const ratio =
          Math.max(env1Items.length, env2Items.length) /
          Math.min(env1Items.length, env2Items.length);
        expect(ratio).toBeLessThan(2);
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should remove batch from master queue after processing all items", async ({
      redisContainer,
    }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        // Set up a single-item batch
        await setupRedisWithBatch(redisContainer, "batch1", "env1", 1);

        // Verify batch is in master queue
        let batches = await scheduler.getBatches();
        expect(batches).toContainEqual({ envId: "env1", batchId: "batch1" });

        // Process all items via DRR iteration
        const results = await scheduler.performDRRIteration();
        expect(results).toHaveLength(1);
        expect(results[0].isBatchComplete).toBe(true);
        expect(results[0].envHasMoreBatches).toBe(false);

        // Batch should be removed from master queue
        batches = await scheduler.getBatches();
        expect(batches).not.toContainEqual({ envId: "env1", batchId: "batch1" });
      } finally {
        await scheduler.close();
      }
    });

    redisTest("should process multiple batches from same env in one iteration", async ({
      redisContainer,
    }) => {
      const scheduler = createScheduler(redisContainer);
      try {
        // Set up two single-item batches for same env
        await setupRedisWithBatch(redisContainer, "batch1", "env1", 1);
        await new Promise((resolve) => setTimeout(resolve, 10));
        await setupRedisWithBatch(redisContainer, "batch2", "env1", 1);

        // Verify both batches are in master queue
        let batches = await scheduler.getBatches();
        expect(batches).toHaveLength(2);

        // With quantum=5, both single-item batches should be processed
        const results = await scheduler.performDRRIteration();
        expect(results).toHaveLength(2);

        // First should show envHasMoreBatches=true, second should show false
        expect(results[0].batchId).toBe("batch1");
        expect(results[0].isBatchComplete).toBe(true);
        expect(results[0].envHasMoreBatches).toBe(true);

        expect(results[1].batchId).toBe("batch2");
        expect(results[1].isBatchComplete).toBe(true);
        expect(results[1].envHasMoreBatches).toBe(false);

        // Master queue should be empty
        batches = await scheduler.getBatches();
        expect(batches).toHaveLength(0);
      } finally {
        await scheduler.close();
      }
    });
  });
});
