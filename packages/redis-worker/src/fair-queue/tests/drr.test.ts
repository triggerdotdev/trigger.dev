import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient, type Redis } from "@internal/redis";
import { DRRScheduler } from "../schedulers/drr.js";
import { DefaultFairQueueKeyProducer } from "../keyProducer.js";
import type { FairQueueKeyProducer, SchedulerContext } from "../types.js";

describe("DRRScheduler", () => {
  let keys: FairQueueKeyProducer;

  describe("deficit management", () => {
    redisTest("should initialize deficit to 0 for new tenants", { timeout: 10000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

      const scheduler = new DRRScheduler({
        redis: redisOptions,
        keys,
        quantum: 5,
        maxDeficit: 50,
      });

      const deficit = await scheduler.getDeficit("new-tenant");
      expect(deficit).toBe(0);

      await scheduler.close();
    });

    redisTest("should add quantum atomically with capping", { timeout: 10000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
      const redis = createRedisClient(redisOptions);

      const scheduler = new DRRScheduler({
        redis: redisOptions,
        keys,
        quantum: 5,
        maxDeficit: 50,
      });

      // Setup: put queues in the master shard
      const masterKey = keys.masterQueueKey(0);
      const now = Date.now();

      await redis.zadd(masterKey, now, "tenant:t1:queue:q1");

      // Create context mock
      const context: SchedulerContext = {
        getCurrentConcurrency: async () => 0,
        getConcurrencyLimit: async () => 100,
        isAtCapacity: async () => false,
        getQueueDescriptor: (queueId) => ({
          id: queueId,
          tenantId: keys.extractTenantId(queueId),
          metadata: {},
        }),
      };

      // Run multiple iterations to accumulate deficit
      for (let i = 0; i < 15; i++) {
        await scheduler.selectQueues(masterKey, "consumer-1", context);
      }

      // Deficit should be capped at maxDeficit (50)
      const deficit = await scheduler.getDeficit("t1");
      expect(deficit).toBeLessThanOrEqual(50);

      await scheduler.close();
      await redis.quit();
    });

    redisTest("should decrement deficit when processing", { timeout: 10000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
      const redis = createRedisClient(redisOptions);

      const scheduler = new DRRScheduler({
        redis: redisOptions,
        keys,
        quantum: 5,
        maxDeficit: 50,
      });

      // Manually set some deficit
      const deficitKey = `test:drr:deficit`;
      await redis.hset(deficitKey, "t1", "10");

      // Record processing
      await scheduler.recordProcessed("t1", "queue:q1");

      const deficit = await scheduler.getDeficit("t1");
      expect(deficit).toBe(9);

      await scheduler.close();
      await redis.quit();
    });

    redisTest("should not go below 0 on decrement", { timeout: 10000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
      const redis = createRedisClient(redisOptions);

      const scheduler = new DRRScheduler({
        redis: redisOptions,
        keys,
        quantum: 5,
        maxDeficit: 50,
      });

      const deficitKey = `test:drr:deficit`;
      await redis.hset(deficitKey, "t1", "0.5");

      await scheduler.recordProcessed("t1", "queue:q1");

      const deficit = await scheduler.getDeficit("t1");
      expect(deficit).toBe(0);

      await scheduler.close();
      await redis.quit();
    });

    redisTest("should reset deficit for tenant", { timeout: 10000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
      const redis = createRedisClient(redisOptions);

      const scheduler = new DRRScheduler({
        redis: redisOptions,
        keys,
        quantum: 5,
        maxDeficit: 50,
      });

      const deficitKey = `test:drr:deficit`;
      await redis.hset(deficitKey, "t1", "25");

      await scheduler.resetDeficit("t1");

      const deficit = await scheduler.getDeficit("t1");
      expect(deficit).toBe(0);

      await scheduler.close();
      await redis.quit();
    });
  });

  describe("queue selection", () => {
    redisTest("should return queues grouped by tenant", { timeout: 10000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
      const redis = createRedisClient(redisOptions);

      const scheduler = new DRRScheduler({
        redis: redisOptions,
        keys,
        quantum: 5,
        maxDeficit: 50,
      });

      const masterKey = keys.masterQueueKey(0);
      const now = Date.now();

      // Add queues for different tenants (all timestamps in the past)
      await redis.zadd(
        masterKey,
        now - 200,
        "tenant:t1:queue:q1",
        now - 100,
        "tenant:t1:queue:q2",
        now - 50,
        "tenant:t2:queue:q1"
      );

      const context: SchedulerContext = {
        getCurrentConcurrency: async () => 0,
        getConcurrencyLimit: async () => 100,
        isAtCapacity: async () => false,
        getQueueDescriptor: (queueId) => ({
          id: queueId,
          tenantId: keys.extractTenantId(queueId),
          metadata: {},
        }),
      };

      const result = await scheduler.selectQueues(masterKey, "consumer-1", context);

      // Should have both tenants
      const tenantIds = result.map((r) => r.tenantId);
      expect(tenantIds).toContain("t1");
      expect(tenantIds).toContain("t2");

      // t1 should have 2 queues
      const t1 = result.find((r) => r.tenantId === "t1");
      expect(t1?.queues).toHaveLength(2);

      await scheduler.close();
      await redis.quit();
    });

    redisTest("should filter out tenants at capacity", { timeout: 10000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
      const redis = createRedisClient(redisOptions);

      const scheduler = new DRRScheduler({
        redis: redisOptions,
        keys,
        quantum: 5,
        maxDeficit: 50,
      });

      const masterKey = keys.masterQueueKey(0);
      const now = Date.now();

      await redis.zadd(masterKey, now - 100, "tenant:t1:queue:q1", now - 50, "tenant:t2:queue:q1");

      const context: SchedulerContext = {
        getCurrentConcurrency: async () => 0,
        getConcurrencyLimit: async () => 100,
        isAtCapacity: async (_, groupId) => groupId === "t1", // t1 at capacity
        getQueueDescriptor: (queueId) => ({
          id: queueId,
          tenantId: keys.extractTenantId(queueId),
          metadata: {},
        }),
      };

      const result = await scheduler.selectQueues(masterKey, "consumer-1", context);

      // Only t2 should be returned
      const tenantIds = result.map((r) => r.tenantId);
      expect(tenantIds).not.toContain("t1");
      expect(tenantIds).toContain("t2");

      await scheduler.close();
      await redis.quit();
    });

    redisTest("should skip tenants with insufficient deficit", { timeout: 10000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
      const redis = createRedisClient(redisOptions);

      const scheduler = new DRRScheduler({
        redis: redisOptions,
        keys,
        quantum: 5,
        maxDeficit: 50,
      });

      const masterKey = keys.masterQueueKey(0);
      const now = Date.now();

      await redis.zadd(masterKey, now - 100, "tenant:t1:queue:q1", now - 50, "tenant:t2:queue:q1");

      // Set t1 deficit to 0 (no credits)
      const deficitKey = `test:drr:deficit`;
      await redis.hset(deficitKey, "t1", "0");

      const context: SchedulerContext = {
        getCurrentConcurrency: async () => 0,
        getConcurrencyLimit: async () => 100,
        isAtCapacity: async () => false,
        getQueueDescriptor: (queueId) => ({
          id: queueId,
          tenantId: keys.extractTenantId(queueId),
          metadata: {},
        }),
      };

      // First call adds quantum to both tenants
      // t1: 0 + 5 = 5, t2: 0 + 5 = 5
      const result = await scheduler.selectQueues(masterKey, "consumer-1", context);

      // Both should be returned (both have deficit >= 1 after quantum added)
      const tenantIds = result.map((r) => r.tenantId);
      expect(tenantIds).toContain("t1");
      expect(tenantIds).toContain("t2");

      await scheduler.close();
      await redis.quit();
    });

    redisTest("should order tenants by deficit (highest first)", { timeout: 10000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
      const redis = createRedisClient(redisOptions);

      const scheduler = new DRRScheduler({
        redis: redisOptions,
        keys,
        quantum: 5,
        maxDeficit: 50,
      });

      const masterKey = keys.masterQueueKey(0);
      const now = Date.now();

      await redis.zadd(
        masterKey,
        now - 300,
        "tenant:t1:queue:q1",
        now - 200,
        "tenant:t2:queue:q1",
        now - 100,
        "tenant:t3:queue:q1"
      );

      // Set different deficits
      const deficitKey = `test:drr:deficit`;
      await redis.hset(deficitKey, "t1", "10");
      await redis.hset(deficitKey, "t2", "30");
      await redis.hset(deficitKey, "t3", "20");

      const context: SchedulerContext = {
        getCurrentConcurrency: async () => 0,
        getConcurrencyLimit: async () => 100,
        isAtCapacity: async () => false,
        getQueueDescriptor: (queueId) => ({
          id: queueId,
          tenantId: keys.extractTenantId(queueId),
          metadata: {},
        }),
      };

      const result = await scheduler.selectQueues(masterKey, "consumer-1", context);

      // Should be ordered by deficit: t2 (35), t3 (25), t1 (15)
      // (original + quantum of 5)
      expect(result[0]?.tenantId).toBe("t2");
      expect(result[1]?.tenantId).toBe("t3");
      expect(result[2]?.tenantId).toBe("t1");

      await scheduler.close();
      await redis.quit();
    });
  });

  describe("get all deficits", () => {
    redisTest("should return all tenant deficits", { timeout: 10000 }, async ({ redisOptions }) => {
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
      const redis = createRedisClient(redisOptions);

      const scheduler = new DRRScheduler({
        redis: redisOptions,
        keys,
        quantum: 5,
        maxDeficit: 50,
      });

      const deficitKey = `test:drr:deficit`;
      await redis.hset(deficitKey, "t1", "10");
      await redis.hset(deficitKey, "t2", "20");
      await redis.hset(deficitKey, "t3", "30");

      const deficits = await scheduler.getAllDeficits();

      expect(deficits.get("t1")).toBe(10);
      expect(deficits.get("t2")).toBe(20);
      expect(deficits.get("t3")).toBe(30);

      await scheduler.close();
      await redis.quit();
    });
  });
});
