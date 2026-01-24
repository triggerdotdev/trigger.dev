import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { VisibilityManager, DefaultFairQueueKeyProducer } from "../index.js";
import type { FairQueueKeyProducer, ReclaimedMessageInfo } from "../types.js";

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

    redisTest(
      "should claim all available messages when queue has fewer than maxCount",
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
        const queueId = "tenant:t1:queue:partial-batch";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);

        // Add only 3 messages to the queue
        for (let i = 1; i <= 3; i++) {
          const messageId = `msg-${i}`;
          const storedMessage = {
            id: messageId,
            queueId,
            tenantId: "t1",
            payload: { value: `test-${i}` },
            timestamp: Date.now() - (4 - i) * 1000,
            attempt: 1,
          };
          await redis.zadd(queueKey, storedMessage.timestamp, messageId);
          await redis.hset(queueItemsKey, messageId, JSON.stringify(storedMessage));
        }

        // Request 10 messages but only 3 exist
        const claimed = await manager.claimBatch(queueId, queueKey, queueItemsKey, "consumer-1", 10);

        expect(claimed).toHaveLength(3);
        expect(claimed[0]!.messageId).toBe("msg-1");
        expect(claimed[1]!.messageId).toBe("msg-2");
        expect(claimed[2]!.messageId).toBe("msg-3");

        // Verify all messages are in in-flight set
        const inflightCount = await manager.getTotalInflightCount();
        expect(inflightCount).toBe(3);

        // Verify queue is empty
        const remainingCount = await redis.zcard(queueKey);
        expect(remainingCount).toBe(0);

        await manager.close();
        await redis.quit();
      }
    );

    redisTest(
      "should skip corrupted messages and continue claiming valid ones",
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
        const queueId = "tenant:t1:queue:corrupted-batch";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);

        // Add valid message 1
        const storedMessage1 = {
          id: "msg-1",
          queueId,
          tenantId: "t1",
          payload: { value: "test-1" },
          timestamp: Date.now() - 3000,
          attempt: 1,
        };
        await redis.zadd(queueKey, storedMessage1.timestamp, "msg-1");
        await redis.hset(queueItemsKey, "msg-1", JSON.stringify(storedMessage1));

        // Add corrupted message 2 (invalid JSON)
        await redis.zadd(queueKey, Date.now() - 2000, "msg-2");
        await redis.hset(queueItemsKey, "msg-2", "not-valid-json{{{");

        // Add valid message 3
        const storedMessage3 = {
          id: "msg-3",
          queueId,
          tenantId: "t1",
          payload: { value: "test-3" },
          timestamp: Date.now() - 1000,
          attempt: 1,
        };
        await redis.zadd(queueKey, storedMessage3.timestamp, "msg-3");
        await redis.hset(queueItemsKey, "msg-3", JSON.stringify(storedMessage3));

        // Claim all 3 messages
        const claimed = await manager.claimBatch(queueId, queueKey, queueItemsKey, "consumer-1", 5);

        // Should only return the 2 valid messages
        expect(claimed).toHaveLength(2);
        expect(claimed[0]!.messageId).toBe("msg-1");
        expect(claimed[1]!.messageId).toBe("msg-3");

        // Corrupted message should have been removed from in-flight
        // Valid messages should be in in-flight
        const inflightCount = await manager.getTotalInflightCount();
        expect(inflightCount).toBe(2);

        // Queue should be empty (all messages processed or removed)
        const remainingCount = await redis.zcard(queueKey);
        expect(remainingCount).toBe(0);

        await manager.close();
        await redis.quit();
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

  describe("reclaimTimedOut", () => {
    redisTest(
      "should return reclaimed message info with tenantId for concurrency release",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new VisibilityManager({
          redis: redisOptions,
          keys,
          shardCount: 1,
          defaultTimeoutMs: 100, // Very short timeout
        });

        const redis = createRedisClient(redisOptions);
        const queueId = "tenant:t1:queue:reclaim-test";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);
        const masterQueueKey = keys.masterQueueKey(0);

        // Add and claim a message
        const messageId = "reclaim-msg";
        const storedMessage = {
          id: messageId,
          queueId,
          tenantId: "t1",
          payload: { id: 1, value: "test" },
          timestamp: Date.now() - 1000,
          attempt: 1,
          metadata: { orgId: "org-123" },
        };

        await redis.zadd(queueKey, storedMessage.timestamp, messageId);
        await redis.hset(queueItemsKey, messageId, JSON.stringify(storedMessage));

        // Claim with very short timeout
        const claimResult = await manager.claim(queueId, queueKey, queueItemsKey, "consumer-1", 100);
        expect(claimResult.claimed).toBe(true);

        // Wait for timeout to expire
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Reclaim should return the message info
        const reclaimedMessages = await manager.reclaimTimedOut(0, (qId) => ({
          queueKey: keys.queueKey(qId),
          queueItemsKey: keys.queueItemsKey(qId),
          masterQueueKey,
        }));

        expect(reclaimedMessages).toHaveLength(1);
        expect(reclaimedMessages[0]).toEqual({
          messageId,
          queueId,
          tenantId: "t1",
          metadata: { orgId: "org-123" },
        });

        // Verify message is back in queue
        const queueCount = await redis.zcard(queueKey);
        expect(queueCount).toBe(1);

        // Verify message is back in queue with its original timestamp (not the deadline)
        const queueMessages = await redis.zrange(queueKey, 0, -1, "WITHSCORES");
        expect(queueMessages[0]).toBe(messageId);
        expect(parseInt(queueMessages[1]!)).toBe(storedMessage.timestamp);

        // Verify message is no longer in-flight
        const inflightCount = await manager.getTotalInflightCount();
        expect(inflightCount).toBe(0);

        await manager.close();
        await redis.quit();
      }
    );

    redisTest(
      "should return empty array when no messages have timed out",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new VisibilityManager({
          redis: redisOptions,
          keys,
          shardCount: 1,
          defaultTimeoutMs: 60000, // Long timeout
        });

        const redis = createRedisClient(redisOptions);
        const queueId = "tenant:t1:queue:no-timeout";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);
        const masterQueueKey = keys.masterQueueKey(0);

        // Add and claim a message with long timeout
        const messageId = "long-timeout-msg";
        const storedMessage = {
          id: messageId,
          queueId,
          tenantId: "t1",
          payload: { id: 1 },
          timestamp: Date.now() - 1000,
          attempt: 1,
        };

        await redis.zadd(queueKey, storedMessage.timestamp, messageId);
        await redis.hset(queueItemsKey, messageId, JSON.stringify(storedMessage));

        await manager.claim(queueId, queueKey, queueItemsKey, "consumer-1");

        // Reclaim should return empty array (message hasn't timed out)
        const reclaimedMessages = await manager.reclaimTimedOut(0, (qId) => ({
          queueKey: keys.queueKey(qId),
          queueItemsKey: keys.queueItemsKey(qId),
          masterQueueKey,
        }));

        expect(reclaimedMessages).toHaveLength(0);

        await manager.close();
        await redis.quit();
      }
    );

    redisTest(
      "should reclaim multiple timed-out messages and return all their info",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new VisibilityManager({
          redis: redisOptions,
          keys,
          shardCount: 1,
          defaultTimeoutMs: 100,
        });

        const redis = createRedisClient(redisOptions);
        const masterQueueKey = keys.masterQueueKey(0);

        // Add and claim messages for two different tenants
        for (const tenant of ["t1", "t2"]) {
          const queueId = `tenant:${tenant}:queue:multi-reclaim`;
          const queueKey = keys.queueKey(queueId);
          const queueItemsKey = keys.queueItemsKey(queueId);

          const messageId = `msg-${tenant}`;
          const storedMessage = {
            id: messageId,
            queueId,
            tenantId: tenant,
            payload: { id: 1 },
            timestamp: Date.now() - 1000,
            attempt: 1,
          };

          await redis.zadd(queueKey, storedMessage.timestamp, messageId);
          await redis.hset(queueItemsKey, messageId, JSON.stringify(storedMessage));

          await manager.claim(queueId, queueKey, queueItemsKey, "consumer-1", 100);
        }

        // Wait for timeout
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Reclaim should return both messages
        const reclaimedMessages = await manager.reclaimTimedOut(0, (qId) => ({
          queueKey: keys.queueKey(qId),
          queueItemsKey: keys.queueItemsKey(qId),
          masterQueueKey,
        }));

        expect(reclaimedMessages).toHaveLength(2);

        // Verify both tenants are represented
        const tenantIds = reclaimedMessages.map((m: ReclaimedMessageInfo) => m.tenantId).sort();
        expect(tenantIds).toEqual(["t1", "t2"]);

        await manager.close();
        await redis.quit();
      }
    );

    redisTest(
      "should use fallback tenantId extraction when message data is missing or corrupted",
      { timeout: 10000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new VisibilityManager({
          redis: redisOptions,
          keys,
          shardCount: 1,
          defaultTimeoutMs: 100,
        });

        const redis = createRedisClient(redisOptions);
        const queueId = "tenant:t1:queue:fallback-test";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);
        const masterQueueKey = keys.masterQueueKey(0);
        const inflightDataKey = keys.inflightDataKey(0);

        // Add and claim a message
        const messageId = "fallback-msg";
        const storedMessage = {
          id: messageId,
          queueId,
          tenantId: "t1",
          payload: { id: 1 },
          timestamp: Date.now() - 1000,
          attempt: 1,
          metadata: { orgId: "org-123" },
        };

        await redis.zadd(queueKey, storedMessage.timestamp, messageId);
        await redis.hset(queueItemsKey, messageId, JSON.stringify(storedMessage));

        // Claim the message
        const claimResult = await manager.claim(queueId, queueKey, queueItemsKey, "consumer-1", 100);
        expect(claimResult.claimed).toBe(true);

        // Corrupt the in-flight data by setting invalid JSON
        await redis.hset(inflightDataKey, messageId, "not-valid-json{{{");

        // Wait for timeout
        await new Promise((resolve) => setTimeout(resolve, 150));

        // Reclaim should still work using fallback extraction
        const reclaimedMessages = await manager.reclaimTimedOut(0, (qId) => ({
          queueKey: keys.queueKey(qId),
          queueItemsKey: keys.queueItemsKey(qId),
          masterQueueKey,
        }));

        expect(reclaimedMessages).toHaveLength(1);
        expect(reclaimedMessages[0]).toEqual({
          messageId,
          queueId,
          tenantId: "t1", // Extracted from queueId via fallback
          metadata: {}, // Empty metadata since we couldn't parse the stored message
        });

        await manager.close();
        await redis.quit();
      }
    );
  });
});

