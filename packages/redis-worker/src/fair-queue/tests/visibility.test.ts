import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { VisibilityManager, DefaultFairQueueKeyProducer } from "../index.js";
import type { FairQueueKeyProducer } from "../types.js";

describe("VisibilityManager", () => {
  let keys: FairQueueKeyProducer;

  describe("heartbeat", () => {
    redisTest(
      "should return true when message exists in in-flight set",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new VisibilityManager({
          redis: redisOptions,
          keys,
          shardCount: 1,
          defaultTimeoutMs: 5000,
        });

        const redis = createRedisClient(redisOptions);
        const queueId = "tenant:t1:queue:heartbeat-exists";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);

        // Add a message to the queue
        const messageId = "heartbeat-test-msg";
        const storedMessage = {
          id: messageId,
          queueId,
          tenantId: "t1",
          payload: { id: 1, value: "test" },
          timestamp: Date.now() - 1000,
          attempt: 1,
        };

        await redis.zadd(queueKey, storedMessage.timestamp, messageId);
        await redis.hset(queueItemsKey, messageId, JSON.stringify(storedMessage));

        // Claim the message (moves it to in-flight set)
        const claimResult = await manager.claim(queueId, queueKey, queueItemsKey, "consumer-1", 5000);
        expect(claimResult.claimed).toBe(true);

        // Heartbeat should succeed since message is in-flight
        const heartbeatResult = await manager.heartbeat(messageId, queueId, 5000);
        expect(heartbeatResult).toBe(true);

        await manager.close();
        await redis.quit();
      }
    );

    redisTest(
      "should return false when message does not exist in in-flight set",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new VisibilityManager({
          redis: redisOptions,
          keys,
          shardCount: 1,
          defaultTimeoutMs: 5000,
        });

        // Heartbeat for a message that was never claimed
        const heartbeatResult = await manager.heartbeat(
          "non-existent-msg",
          "tenant:t1:queue:non-existent",
          5000
        );
        expect(heartbeatResult).toBe(false);

        await manager.close();
      }
    );

    redisTest(
      "should return false after message is completed",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new VisibilityManager({
          redis: redisOptions,
          keys,
          shardCount: 1,
          defaultTimeoutMs: 5000,
        });

        const redis = createRedisClient(redisOptions);
        const queueId = "tenant:t1:queue:heartbeat-after-complete";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);

        // Add and claim a message
        const messageId = "completed-msg";
        const storedMessage = {
          id: messageId,
          queueId,
          tenantId: "t1",
          payload: { id: 1, value: "test" },
          timestamp: Date.now() - 1000,
          attempt: 1,
        };

        await redis.zadd(queueKey, storedMessage.timestamp, messageId);
        await redis.hset(queueItemsKey, messageId, JSON.stringify(storedMessage));

        const claimResult = await manager.claim(queueId, queueKey, queueItemsKey, "consumer-1", 5000);
        expect(claimResult.claimed).toBe(true);

        // Heartbeat should work before complete
        const heartbeatBefore = await manager.heartbeat(messageId, queueId, 5000);
        expect(heartbeatBefore).toBe(true);

        // Complete the message
        await manager.complete(messageId, queueId);

        // Heartbeat should fail after complete
        const heartbeatAfter = await manager.heartbeat(messageId, queueId, 5000);
        expect(heartbeatAfter).toBe(false);

        await manager.close();
        await redis.quit();
      }
    );

    redisTest(
      "should correctly update the deadline score",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new VisibilityManager({
          redis: redisOptions,
          keys,
          shardCount: 1,
          defaultTimeoutMs: 1000,
        });

        const redis = createRedisClient(redisOptions);
        const queueId = "tenant:t1:queue:heartbeat-deadline";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);

        // Add and claim a message with short timeout
        const messageId = "deadline-test-msg";
        const storedMessage = {
          id: messageId,
          queueId,
          tenantId: "t1",
          payload: { id: 1, value: "test" },
          timestamp: Date.now() - 1000,
          attempt: 1,
        };

        await redis.zadd(queueKey, storedMessage.timestamp, messageId);
        await redis.hset(queueItemsKey, messageId, JSON.stringify(storedMessage));

        // Claim with 1 second timeout
        await manager.claim(queueId, queueKey, queueItemsKey, "consumer-1", 1000);

        // Get initial deadline
        const inflightKey = keys.inflightKey(0);
        const member = `${messageId}:${queueId}`;
        const initialScore = await redis.zscore(inflightKey, member);
        expect(initialScore).not.toBeNull();

        // Wait a bit
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Extend deadline by 10 seconds
        const beforeHeartbeat = Date.now();
        const heartbeatSuccess = await manager.heartbeat(messageId, queueId, 10000);
        expect(heartbeatSuccess).toBe(true);

        // Check that deadline was extended
        const newScore = await redis.zscore(inflightKey, member);
        expect(newScore).not.toBeNull();

        // New deadline should be approximately now + 10 seconds
        const newDeadline = parseFloat(newScore!);
        expect(newDeadline).toBeGreaterThan(parseFloat(initialScore!));
        expect(newDeadline).toBeGreaterThanOrEqual(beforeHeartbeat + 10000);
        // Allow some tolerance for execution time
        expect(newDeadline).toBeLessThan(beforeHeartbeat + 11000);

        await manager.close();
        await redis.quit();
      }
    );

    redisTest(
      "should handle multiple consecutive heartbeats",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new VisibilityManager({
          redis: redisOptions,
          keys,
          shardCount: 1,
          defaultTimeoutMs: 1000,
        });

        const redis = createRedisClient(redisOptions);
        const queueId = "tenant:t1:queue:multi-heartbeat";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);

        // Add and claim a message
        const messageId = "multi-heartbeat-msg";
        const storedMessage = {
          id: messageId,
          queueId,
          tenantId: "t1",
          payload: { id: 1, value: "test" },
          timestamp: Date.now() - 1000,
          attempt: 1,
        };

        await redis.zadd(queueKey, storedMessage.timestamp, messageId);
        await redis.hset(queueItemsKey, messageId, JSON.stringify(storedMessage));

        await manager.claim(queueId, queueKey, queueItemsKey, "consumer-1", 1000);

        // Multiple heartbeats should all succeed
        for (let i = 0; i < 5; i++) {
          const result = await manager.heartbeat(messageId, queueId, 1000);
          expect(result).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        // Message should still be in-flight
        const inflightCount = await manager.getTotalInflightCount();
        expect(inflightCount).toBe(1);

        await manager.close();
        await redis.quit();
      }
    );
  });
});

