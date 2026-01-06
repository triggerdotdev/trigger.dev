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

  describe("claimBatch", () => {
    redisTest(
      "should claim multiple messages atomically",
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
        const queueId = "tenant:t1:queue:claim-batch";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);

        // Add multiple messages to the queue
        for (let i = 1; i <= 5; i++) {
          const messageId = `msg-${i}`;
          const storedMessage = {
            id: messageId,
            queueId,
            tenantId: "t1",
            payload: { value: `test-${i}` },
            timestamp: Date.now() - (6 - i) * 1000,
            attempt: 1,
          };
          await redis.zadd(queueKey, storedMessage.timestamp, messageId);
          await redis.hset(queueItemsKey, messageId, JSON.stringify(storedMessage));
        }

        // Claim batch of 3 messages
        const claimed = await manager.claimBatch(queueId, queueKey, queueItemsKey, "consumer-1", 3);

        expect(claimed).toHaveLength(3);
        expect(claimed[0]!.messageId).toBe("msg-1");
        expect(claimed[1]!.messageId).toBe("msg-2");
        expect(claimed[2]!.messageId).toBe("msg-3");

        // Verify messages are in in-flight set
        const inflightCount = await manager.getTotalInflightCount();
        expect(inflightCount).toBe(3);

        // Verify messages are removed from queue
        const remainingCount = await redis.zcard(queueKey);
        expect(remainingCount).toBe(2);

        await manager.close();
        await redis.quit();
      }
    );

    redisTest(
      "should return empty array when queue is empty",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new VisibilityManager({
          redis: redisOptions,
          keys,
          shardCount: 1,
          defaultTimeoutMs: 5000,
        });

        const queueId = "tenant:t1:queue:empty";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);

        const claimed = await manager.claimBatch(queueId, queueKey, queueItemsKey, "consumer-1", 5);
        expect(claimed).toHaveLength(0);

        await manager.close();
      }
    );
  });

  describe("releaseBatch", () => {
    redisTest(
      "should release multiple messages back to queue atomically",
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
        const queueId = "tenant:t1:queue:release-batch";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);
        const masterQueueKey = keys.masterQueueKey(0);

        // Add messages to queue and claim them
        for (let i = 1; i <= 5; i++) {
          const messageId = `msg-${i}`;
          const storedMessage = {
            id: messageId,
            queueId,
            tenantId: "t1",
            payload: { value: `test-${i}` },
            timestamp: Date.now() - (6 - i) * 1000,
            attempt: 1,
          };
          await redis.zadd(queueKey, storedMessage.timestamp, messageId);
          await redis.hset(queueItemsKey, messageId, JSON.stringify(storedMessage));
        }

        // Claim all 5 messages
        const claimed = await manager.claimBatch(queueId, queueKey, queueItemsKey, "consumer-1", 5);
        expect(claimed).toHaveLength(5);

        // Verify all messages are in-flight
        let inflightCount = await manager.getTotalInflightCount();
        expect(inflightCount).toBe(5);

        // Queue should be empty
        let queueCount = await redis.zcard(queueKey);
        expect(queueCount).toBe(0);

        // Release messages 3, 4, 5 back to queue (batch release)
        const messagesToRelease = claimed.slice(2);
        await manager.releaseBatch(
          messagesToRelease,
          queueId,
          queueKey,
          queueItemsKey,
          masterQueueKey
        );

        // Verify 2 messages still in-flight
        inflightCount = await manager.getTotalInflightCount();
        expect(inflightCount).toBe(2);

        // Verify 3 messages back in queue
        queueCount = await redis.zcard(queueKey);
        expect(queueCount).toBe(3);

        // Verify the correct messages are back in queue
        const queueMembers = await redis.zrange(queueKey, 0, -1);
        expect(queueMembers).toContain("msg-3");
        expect(queueMembers).toContain("msg-4");
        expect(queueMembers).toContain("msg-5");

        await manager.close();
        await redis.quit();
      }
    );

    redisTest(
      "should handle empty messages array",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new VisibilityManager({
          redis: redisOptions,
          keys,
          shardCount: 1,
          defaultTimeoutMs: 5000,
        });

        const queueId = "tenant:t1:queue:empty-release";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);
        const masterQueueKey = keys.masterQueueKey(0);

        // Should not throw when releasing empty array
        await manager.releaseBatch([], queueId, queueKey, queueItemsKey, masterQueueKey);

        await manager.close();
      }
    );

    redisTest(
      "should update master queue with oldest message timestamp",
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
        const queueId = "tenant:t1:queue:master-update";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);
        const masterQueueKey = keys.masterQueueKey(0);

        // Add and claim messages
        const baseTime = Date.now();
        for (let i = 1; i <= 3; i++) {
          const messageId = `msg-${i}`;
          const storedMessage = {
            id: messageId,
            queueId,
            tenantId: "t1",
            payload: { value: `test-${i}` },
            timestamp: baseTime + i * 1000, // Different timestamps
            attempt: 1,
          };
          await redis.zadd(queueKey, storedMessage.timestamp, messageId);
          await redis.hset(queueItemsKey, messageId, JSON.stringify(storedMessage));
        }

        const claimed = await manager.claimBatch(queueId, queueKey, queueItemsKey, "consumer-1", 3);

        // Release all messages back
        await manager.releaseBatch(claimed, queueId, queueKey, queueItemsKey, masterQueueKey);

        // Master queue should have been updated
        const masterScore = await redis.zscore(masterQueueKey, queueId);
        expect(masterScore).not.toBeNull();

        await manager.close();
        await redis.quit();
      }
    );
  });
});

