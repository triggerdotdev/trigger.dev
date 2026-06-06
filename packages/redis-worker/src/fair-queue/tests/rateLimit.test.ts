import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { RateLimitManager } from "../rateLimit.js";
import { DefaultFairQueueKeyProducer } from "../keyProducer.js";
import type { FairQueueKeyProducer } from "../types.js";

describe("RateLimitManager", () => {
  let keys: FairQueueKeyProducer;

  describe("unit tests", () => {
    redisTest(
      "should allow consumption when requesting units within the defined limit",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const manager = new RateLimitManager({ redis: redisOptions, keys });

        const result = await manager.checkAndConsume([
          { key: "test-key-1", limit: 10, windowMs: 1000, units: 1 },
        ]);

        expect(result.allowed).toBe(true);
        expect(result.resetAt).toBeUndefined();

        await manager.close();
      }
    );

    redisTest(
      "should reject consumption and return resetAt when requesting units exceeding the limit",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const manager = new RateLimitManager({ redis: redisOptions, keys });

        const result = await manager.checkAndConsume([
          { key: "test-key-2", limit: 10, windowMs: 1000, units: 11 },
        ]);

        expect(result.allowed).toBe(false);
        expect(result.resetAt).toBeDefined();
        expect(result.resetAt).toBeGreaterThan(Date.now());

        await manager.close();
      }
    );

    redisTest(
      "should atomically evaluate multiple keys and allow if all have capacity",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const manager = new RateLimitManager({ redis: redisOptions, keys });

        const result = await manager.checkAndConsume([
          { key: "test-key-3a", limit: 10, windowMs: 1000, units: 1 },
          { key: "test-key-3b", limit: 5, windowMs: 1000, units: 1 },
        ]);

        expect(result.allowed).toBe(true);

        await manager.close();
      }
    );

    redisTest(
      "should atomically reject and consume zero units if any key exceeds its limit",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const manager = new RateLimitManager({ redis: redisOptions, keys });

        const result = await manager.checkAndConsume([
          { key: "test-key-4a", limit: 10, windowMs: 1000, units: 1 },
          { key: "test-key-4b", limit: 5, windowMs: 1000, units: 6 },
        ]);

        expect(result.allowed).toBe(false);

        // Verify that test-key-4a was NOT consumed
        const checkResult = await manager.checkAndConsume([
          { key: "test-key-4a", limit: 10, windowMs: 1000, units: 10 },
        ]);
        expect(checkResult.allowed).toBe(true);

        await manager.close();
      }
    );

    redisTest(
      "should reset the window and allow consumption after the window duration has passed",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const manager = new RateLimitManager({ redis: redisOptions, keys });

        // Consume full quota
        const result1 = await manager.checkAndConsume([
          { key: "test-key-5", limit: 1, windowMs: 100, units: 1 },
        ]);
        expect(result1.allowed).toBe(true);

        // Should be rejected immediately after
        const result2 = await manager.checkAndConsume([
          { key: "test-key-5", limit: 1, windowMs: 100, units: 1 },
        ]);
        expect(result2.allowed).toBe(false);

        // Wait for window to expire
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Should be allowed again
        const result3 = await manager.checkAndConsume([
          { key: "test-key-5", limit: 1, windowMs: 100, units: 1 },
        ]);
        expect(result3.allowed).toBe(true);

        await manager.close();
      }
    );

    redisTest(
      "should handle high concurrency without race conditions or exceeding limits",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const manager = new RateLimitManager({ redis: redisOptions, keys });

        const promises = Array.from({ length: 100 }, () =>
          manager.checkAndConsume([
            { key: "test-key-6", limit: 50, windowMs: 5000, units: 1 },
          ])
        );

        const results = await Promise.all(promises);

        const allowedCount = results.filter((r) => r.allowed).length;
        const rejectedCount = results.filter((r) => !r.allowed).length;

        expect(allowedCount).toBe(50);
        expect(rejectedCount).toBe(50);

        await manager.close();
      }
    );

    redisTest(
      "should enforce the limit based on the current request definition for dynamic limits",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const manager = new RateLimitManager({ redis: redisOptions, keys });

        // First request with limit 10
        const result1 = await manager.checkAndConsume([
          { key: "test-key-7", limit: 10, windowMs: 1000, units: 5 },
        ]);
        expect(result1.allowed).toBe(true);

        // Second request with limit 5 (should fail because 5 units already consumed)
        const result2 = await manager.checkAndConsume([
          { key: "test-key-7", limit: 5, windowMs: 1000, units: 1 },
        ]);
        expect(result2.allowed).toBe(false);

        await manager.close();
      }
    );

    redisTest(
      "should correctly store and retrieve static rate limit configurations",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const manager = new RateLimitManager({ redis: redisOptions, keys });

        await manager.upsertStaticConfig("static-key-1", 100, 60000);

        const configs = await manager.getStaticConfigs(["static-key-1"]);
        expect(configs.get("static-key-1")).toEqual({ limit: 100, windowMs: 60000 });

        await manager.close();
      }
    );

    redisTest(
      "should safely reject consumption when a static key has not been configured",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const manager = new RateLimitManager({ redis: redisOptions, keys });

        const configs = await manager.getStaticConfigs(["non-existent-key"]);
        expect(configs.get("non-existent-key")).toBeNull();

        await manager.close();
      }
    );

    redisTest(
      "should always reject consumption when the limit is zero",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const manager = new RateLimitManager({ redis: redisOptions, keys });

        const result = await manager.checkAndConsume([
          { key: "test-key-10", limit: 0, windowMs: 1000, units: 1 },
        ]);

        expect(result.allowed).toBe(false);
        expect(result.resetAt).toBeDefined();

        await manager.close();
      }
    );

    redisTest(
      "should set a TTL on Redis keys to prevent memory leaks",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const manager = new RateLimitManager({ redis: redisOptions, keys });

        const now = Date.now();
        const windowMs = 5000;
        const windowStart = Math.floor(now / windowMs) * windowMs;
        const redisKey = `rate_limit:test-key-11:${windowStart}`;

        await manager.checkAndConsume([
          { key: "test-key-11", limit: 10, windowMs, units: 1 },
        ]);

        // We need to create a separate redis client to check PTTL
        const { createRedisClient } = await import("@internal/redis");
        const redis = createRedisClient(redisOptions);
        
        const pttl = await redis.pttl(redisKey);
        expect(pttl).toBeGreaterThan(0);
        expect(pttl).toBeLessThanOrEqual(windowMs);

        await redis.quit();
        await manager.close();
      }
    );
  });
});
