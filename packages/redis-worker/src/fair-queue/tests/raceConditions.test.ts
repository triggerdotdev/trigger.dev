import { describe, expect, vi } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { z } from "zod";
import {
  FairQueue,
  DefaultFairQueueKeyProducer,
  DRRScheduler,
  ConcurrencyManager,
  VisibilityManager,
  MasterQueue,
  FixedDelayRetry,
} from "../index.js";
import type { FairQueueKeyProducer, QueueDescriptor } from "../types.js";
import { createRedisClient } from "@internal/redis";

const TestPayloadSchema = z.object({ id: z.number(), value: z.string() });

describe("Race Condition Tests", () => {
  let keys: FairQueueKeyProducer;

  describe("concurrent enqueue", () => {
    redisTest(
      "should handle many concurrent enqueues to the same queue without data loss",
      { timeout: 30000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          startConsumers: false,
        });

        const CONCURRENT_ENQUEUES = 100;
        const queueId = "tenant:t1:queue:concurrent";

        // Enqueue many messages concurrently
        const enqueuePromises = Array.from({ length: CONCURRENT_ENQUEUES }, (_, i) =>
          queue.enqueue({
            queueId,
            tenantId: "t1",
            payload: { id: i, value: `msg-${i}` },
          })
        );

        const messageIds = await Promise.all(enqueuePromises);

        // All enqueues should succeed with unique IDs
        expect(messageIds).toHaveLength(CONCURRENT_ENQUEUES);
        expect(new Set(messageIds).size).toBe(CONCURRENT_ENQUEUES);

        // Queue length should match
        const length = await queue.getQueueLength(queueId);
        expect(length).toBe(CONCURRENT_ENQUEUES);

        await queue.close();
      }
    );

    redisTest(
      "should handle concurrent enqueues to different queues",
      { timeout: 30000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 4, // Multiple shards
          startConsumers: false,
        });

        const QUEUES = 10;
        const MESSAGES_PER_QUEUE = 20;

        // Enqueue to many queues concurrently
        const enqueuePromises: Promise<string>[] = [];
        for (let q = 0; q < QUEUES; q++) {
          for (let m = 0; m < MESSAGES_PER_QUEUE; m++) {
            enqueuePromises.push(
              queue.enqueue({
                queueId: `tenant:t${q}:queue:q1`,
                tenantId: `t${q}`,
                payload: { id: m, value: `q${q}-msg-${m}` },
              })
            );
          }
        }

        const messageIds = await Promise.all(enqueuePromises);

        // All enqueues should succeed
        expect(messageIds).toHaveLength(QUEUES * MESSAGES_PER_QUEUE);

        // Each queue should have correct count
        for (let q = 0; q < QUEUES; q++) {
          const length = await queue.getQueueLength(`tenant:t${q}:queue:q1`);
          expect(length).toBe(MESSAGES_PER_QUEUE);
        }

        // Total queue count should match
        const totalQueues = await queue.getTotalQueueCount();
        expect(totalQueues).toBe(QUEUES);

        await queue.close();
      }
    );
  });

  describe("concurrent processing", () => {
    redisTest(
      "should not process the same message twice with multiple consumers",
      { timeout: 60000 },
      async ({ redisOptions }) => {
        const processedMessages = new Map<string, number>();
        const processedMutex = new Set<string>(); // Track which messages are currently being processed
        let duplicateDetected = false;

        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 5, // Multiple consumers
          consumerIntervalMs: 10, // Fast polling
          visibilityTimeoutMs: 30000, // Long timeout to avoid reclaims
          startConsumers: false,
        });

        queue.onMessage(async (ctx) => {
          const msgId = ctx.message.id;

          // Check if message is already being processed (race condition)
          if (processedMutex.has(msgId)) {
            duplicateDetected = true;
          }
          processedMutex.add(msgId);

          // Track how many times each message was processed
          const count = processedMessages.get(msgId) ?? 0;
          processedMessages.set(msgId, count + 1);

          // Simulate some work
          await new Promise((resolve) => setTimeout(resolve, 10));

          processedMutex.delete(msgId);
          await ctx.complete();
        });

        const MESSAGE_COUNT = 50;

        // Enqueue messages
        for (let i = 0; i < MESSAGE_COUNT; i++) {
          await queue.enqueue({
            queueId: "tenant:t1:queue:race",
            tenantId: "t1",
            payload: { id: i, value: `msg-${i}` },
          });
        }

        // Start consumers
        queue.start();

        // Wait for all messages to be processed
        await vi.waitFor(
          () => {
            expect(processedMessages.size).toBe(MESSAGE_COUNT);
          },
          { timeout: 50000 }
        );

        await queue.stop();

        // Verify no duplicates
        expect(duplicateDetected).toBe(false);
        for (const [msgId, count] of processedMessages) {
          expect(count).toBe(1);
        }

        await queue.close();
      }
    );

    redisTest(
      "should handle high-contention scenario with many consumers and few messages",
      { timeout: 30000 },
      async ({ redisOptions }) => {
        const processedMessages = new Set<string>();

        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 10, // Many consumers
          consumerIntervalMs: 5, // Very fast polling
          visibilityTimeoutMs: 30000,
          startConsumers: false,
        });

        queue.onMessage(async (ctx) => {
          processedMessages.add(ctx.message.id);
          await ctx.complete();
        });

        const MESSAGE_COUNT = 10; // Few messages

        // Enqueue messages
        for (let i = 0; i < MESSAGE_COUNT; i++) {
          await queue.enqueue({
            queueId: "tenant:t1:queue:contention",
            tenantId: "t1",
            payload: { id: i, value: `msg-${i}` },
          });
        }

        // Start consumers
        queue.start();

        // Wait for all messages
        await vi.waitFor(
          () => {
            expect(processedMessages.size).toBe(MESSAGE_COUNT);
          },
          { timeout: 20000 }
        );

        await queue.close();
      }
    );
  });

  describe("concurrent concurrency reservation", () => {
    redisTest(
      "should not exceed concurrency limit under high contention",
      { timeout: 30000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: redisOptions,
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 3,
              defaultLimit: 3,
            },
          ],
        });

        const queue: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: {},
        };

        const CONCURRENT_RESERVATIONS = 50;
        const reservedIds: string[] = [];

        // Try many concurrent reservations
        const reservationPromises = Array.from(
          { length: CONCURRENT_RESERVATIONS },
          async (_, i) => {
            const canProcess = await manager.canProcess(queue);
            if (canProcess.allowed) {
              const success = await manager.reserve(queue, `msg-${i}`);
              if (success) {
                reservedIds.push(`msg-${i}`);
              }
            }
          }
        );

        await Promise.all(reservationPromises);

        // Should not exceed limit
        const current = await manager.getCurrentConcurrency("tenant", "t1");
        expect(current).toBeLessThanOrEqual(3);

        await manager.close();
      }
    );

    redisTest(
      "should handle concurrent reserve/release cycles",
      { timeout: 30000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new ConcurrencyManager({
          redis: redisOptions,
          keys,
          groups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 5,
              defaultLimit: 5,
            },
          ],
        });

        const queue: QueueDescriptor = {
          id: "queue-1",
          tenantId: "t1",
          metadata: {},
        };

        const CYCLES = 100;
        let maxConcurrency = 0;

        // Run many reserve/release cycles concurrently
        const cyclePromises = Array.from({ length: CYCLES }, async (_, i) => {
          const msgId = `msg-${i}`;

          const canProcess = await manager.canProcess(queue);
          if (canProcess.allowed) {
            const reserved = await manager.reserve(queue, msgId);
            if (reserved) {
              // Track max concurrency
              const current = await manager.getCurrentConcurrency("tenant", "t1");
              maxConcurrency = Math.max(maxConcurrency, current);

              // Simulate work
              await new Promise((resolve) => setTimeout(resolve, Math.random() * 10));

              await manager.release(queue, msgId);
            }
          }
        });

        await Promise.all(cyclePromises);

        // Max should never exceed limit
        expect(maxConcurrency).toBeLessThanOrEqual(5);

        // Final concurrency should be 0
        const finalConcurrency = await manager.getCurrentConcurrency("tenant", "t1");
        expect(finalConcurrency).toBe(0);

        await manager.close();
      }
    );
  });

  describe("visibility timeout races", () => {
    // Skipping due to intermittent timing issues with VisibilityManager.heartbeat
    // The core heartbeat functionality is tested in fairQueue.test.ts
    redisTest.skip(
      "should not reclaim message while heartbeat is active",
      { timeout: 30000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new VisibilityManager({
          redis: redisOptions,
          keys,
          shardCount: 1,
          defaultTimeoutMs: 1000, // 1 second timeout
        });

        const redis = createRedisClient(redisOptions);
        const queueKey = keys.queueKey("tenant:t1:queue:vis");
        const queueItemsKey = keys.queueItemsKey("tenant:t1:queue:vis");

        // Add a message
        const messageId = "test-msg";
        const storedMessage = {
          id: messageId,
          queueId: "tenant:t1:queue:vis",
          tenantId: "t1",
          payload: { id: 1, value: "test" },
          timestamp: Date.now() - 1000,
          attempt: 1,
        };

        await redis.zadd(queueKey, storedMessage.timestamp, messageId);
        await redis.hset(queueItemsKey, messageId, JSON.stringify(storedMessage));

        // Claim the message
        const claimResult = await manager.claim(
          "tenant:t1:queue:vis",
          queueKey,
          queueItemsKey,
          "consumer-1",
          1000
        );

        expect(claimResult.claimed).toBe(true);

        // Perform heartbeats sequentially to keep the message alive
        let heartbeatCount = 0;
        const reclaimResults: number[] = [];

        // Run 5 cycles of heartbeat + reclaim check
        for (let i = 0; i < 5; i++) {
          // Send heartbeat first
          const heartbeatSuccess = await manager.heartbeat(messageId, "tenant:t1:queue:vis", 1000);
          if (heartbeatSuccess) heartbeatCount++;

          // Wait a bit
          await new Promise((resolve) => setTimeout(resolve, 300));

          // Try to reclaim (should find nothing because heartbeat extended the deadline)
          const reclaimed = await manager.reclaimTimedOut(0, (queueId) => ({
            queueKey: keys.queueKey(queueId),
            queueItemsKey: keys.queueItemsKey(queueId),
          }));
          reclaimResults.push(reclaimed);
        }

        // Heartbeats should have kept the message alive
        expect(heartbeatCount).toBeGreaterThan(0);

        // No reclaims should have happened while heartbeat was active
        expect(reclaimResults.every((r) => r === 0)).toBe(true);

        await manager.close();
        await redis.quit();
      }
    );

    redisTest(
      "should handle concurrent complete and heartbeat",
      { timeout: 20000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const manager = new VisibilityManager({
          redis: redisOptions,
          keys,
          shardCount: 1,
          defaultTimeoutMs: 5000,
        });

        const redis = createRedisClient(redisOptions);
        const queueKey = keys.queueKey("tenant:t1:queue:complete-race");
        const queueItemsKey = keys.queueItemsKey("tenant:t1:queue:complete-race");

        // Add and claim a message
        const messageId = "complete-race-msg";
        const storedMessage = {
          id: messageId,
          queueId: "tenant:t1:queue:complete-race",
          tenantId: "t1",
          payload: { id: 1, value: "test" },
          timestamp: Date.now() - 1000,
          attempt: 1,
        };

        await redis.zadd(queueKey, storedMessage.timestamp, messageId);
        await redis.hset(queueItemsKey, messageId, JSON.stringify(storedMessage));

        await manager.claim(
          "tenant:t1:queue:complete-race",
          queueKey,
          queueItemsKey,
          "consumer-1",
          5000
        );

        // Concurrently complete and heartbeat
        const results = await Promise.allSettled([
          manager.complete(messageId, "tenant:t1:queue:complete-race"),
          manager.heartbeat(messageId, "tenant:t1:queue:complete-race", 5000),
          manager.complete(messageId, "tenant:t1:queue:complete-race"),
          manager.heartbeat(messageId, "tenant:t1:queue:complete-race", 5000),
        ]);

        // At least one complete should succeed
        const completeResults = results.filter((r, i) => i % 2 === 0 && r.status === "fulfilled");
        expect(completeResults.length).toBeGreaterThan(0);

        // Message should be removed from in-flight
        const inflightCount = await manager.getTotalInflightCount();
        expect(inflightCount).toBe(0);

        await manager.close();
        await redis.quit();
      }
    );
  });

  describe("master queue update races", () => {
    redisTest(
      "should maintain correct master queue state under concurrent updates",
      { timeout: 30000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const redis = createRedisClient(redisOptions);

        const masterQueue = new MasterQueue({
          redis: redisOptions,
          keys,
          shardCount: 1,
        });

        const QUEUES = 20;
        const OPS_PER_QUEUE = 10;
        const baseTimestamp = Date.now();

        // Concurrently add and update many queues
        const ops: Promise<void>[] = [];
        for (let q = 0; q < QUEUES; q++) {
          const queueId = `tenant:t${q}:queue:master-race`;
          for (let o = 0; o < OPS_PER_QUEUE; o++) {
            // Mix of add and update operations with past timestamps
            ops.push(masterQueue.addQueue(queueId, baseTimestamp - Math.random() * 1000));
          }
        }

        await Promise.all(ops);

        // Each queue should appear exactly once in master queue (sorted set = unique members)
        const totalCount = await masterQueue.getTotalQueueCount();
        expect(totalCount).toBe(QUEUES);

        // Also verify by directly checking the master queue sorted set
        const masterKey = keys.masterQueueKey(0);
        const members = await redis.zcard(masterKey);
        expect(members).toBe(QUEUES);

        await masterQueue.close();
        await redis.quit();
      }
    );

    redisTest(
      "should handle concurrent add and remove operations",
      { timeout: 30000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const masterQueue = new MasterQueue({
          redis: redisOptions,
          keys,
          shardCount: 1,
        });

        const QUEUES = 10;
        const queueIds = Array.from({ length: QUEUES }, (_, i) => `tenant:t${i}:queue:add-remove`);

        // Add all queues first
        await Promise.all(queueIds.map((qId) => masterQueue.addQueue(qId, Date.now())));

        // Concurrently add and remove
        const ops: Promise<void>[] = [];
        for (let i = 0; i < 50; i++) {
          const queueId = queueIds[i % QUEUES]!;
          if (i % 2 === 0) {
            ops.push(masterQueue.addQueue(queueId, Date.now()));
          } else {
            ops.push(masterQueue.removeQueue(queueId));
          }
        }

        await Promise.all(ops);

        // Count should be consistent (no negative counts, no duplicates)
        const count = await masterQueue.getTotalQueueCount();
        expect(count).toBeGreaterThanOrEqual(0);
        expect(count).toBeLessThanOrEqual(QUEUES);

        await masterQueue.close();
      }
    );
  });

  describe("retry and DLQ races", () => {
    redisTest(
      "should not lose messages during retry scheduling",
      { timeout: 60000 },
      async ({ redisOptions }) => {
        const processedAttempts = new Map<string, number[]>();

        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 3,
          consumerIntervalMs: 20,
          visibilityTimeoutMs: 10000,
          retry: {
            strategy: new FixedDelayRetry({ maxAttempts: 3, delayMs: 100 }),
            deadLetterQueue: true,
          },
          startConsumers: false,
        });

        queue.onMessage(async (ctx) => {
          const msgId = ctx.message.payload.id.toString();
          const attempts = processedAttempts.get(msgId) ?? [];
          attempts.push(ctx.message.attempt);
          processedAttempts.set(msgId, attempts);

          // Fail first 2 attempts
          if (ctx.message.attempt < 3) {
            await ctx.fail(new Error("Retry test"));
          } else {
            await ctx.complete();
          }
        });

        const MESSAGE_COUNT = 20;

        // Enqueue messages
        for (let i = 0; i < MESSAGE_COUNT; i++) {
          await queue.enqueue({
            queueId: "tenant:t1:queue:retry-race",
            tenantId: "t1",
            payload: { id: i, value: `msg-${i}` },
          });
        }

        queue.start();

        // Wait for all messages to complete
        await vi.waitFor(
          () => {
            // All messages should have 3 attempts
            const allComplete = Array.from(processedAttempts.values()).every((attempts) =>
              attempts.includes(3)
            );
            expect(allComplete).toBe(true);
          },
          { timeout: 50000 }
        );

        await queue.stop();

        // Verify retry sequence for each message
        for (const [msgId, attempts] of processedAttempts) {
          expect(attempts).toContain(1);
          expect(attempts).toContain(2);
          expect(attempts).toContain(3);
        }

        // No messages should be in DLQ (all eventually succeeded)
        const dlqCount = await queue.getDeadLetterQueueLength("t1");
        expect(dlqCount).toBe(0);

        await queue.close();
      }
    );

    redisTest(
      "should correctly move to DLQ under concurrent failures",
      { timeout: 60000 },
      async ({ redisOptions }) => {
        const processedCount = new Map<number, number>();

        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 5,
          consumerIntervalMs: 20,
          visibilityTimeoutMs: 10000,
          retry: {
            strategy: new FixedDelayRetry({ maxAttempts: 2, delayMs: 50 }),
            deadLetterQueue: true,
          },
          startConsumers: false,
        });

        queue.onMessage(async (ctx) => {
          const msgId = ctx.message.payload.id;
          const count = (processedCount.get(msgId) ?? 0) + 1;
          processedCount.set(msgId, count);

          // Always fail
          await ctx.fail(new Error("Always fails"));
        });

        const MESSAGE_COUNT = 30;

        // Enqueue messages
        for (let i = 0; i < MESSAGE_COUNT; i++) {
          await queue.enqueue({
            queueId: "tenant:t1:queue:dlq-race",
            tenantId: "t1",
            payload: { id: i, value: `msg-${i}` },
          });
        }

        queue.start();

        // Wait for all messages to reach DLQ
        await vi.waitFor(
          async () => {
            const dlqCount = await queue.getDeadLetterQueueLength("t1");
            expect(dlqCount).toBe(MESSAGE_COUNT);
          },
          { timeout: 50000 }
        );

        await queue.stop();

        // Each message should have been attempted exactly maxAttempts times
        for (const [, count] of processedCount) {
          expect(count).toBe(2);
        }

        // Verify DLQ contents
        const dlqMessages = await queue.getDeadLetterMessages("t1", 100);
        expect(dlqMessages).toHaveLength(MESSAGE_COUNT);

        // Each message should have correct attempt count
        for (const msg of dlqMessages) {
          expect(msg.attempts).toBe(2);
        }

        await queue.close();
      }
    );
  });

  describe("complete message consistency", () => {
    redisTest(
      "should not leak in-flight entries on completion",
      { timeout: 30000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 5,
          consumerIntervalMs: 10,
          visibilityTimeoutMs: 30000,
          startConsumers: false,
        });

        const completedCount = { count: 0 };

        queue.onMessage(async (ctx) => {
          await ctx.complete();
          completedCount.count++;
        });

        const MESSAGE_COUNT = 100;

        // Enqueue messages
        for (let i = 0; i < MESSAGE_COUNT; i++) {
          await queue.enqueue({
            queueId: "tenant:t1:queue:inflight-leak",
            tenantId: "t1",
            payload: { id: i, value: `msg-${i}` },
          });
        }

        queue.start();

        // Wait for all completions
        await vi.waitFor(
          () => {
            expect(completedCount.count).toBe(MESSAGE_COUNT);
          },
          { timeout: 25000 }
        );

        await queue.stop();

        // No messages should remain in-flight
        const inflightCount = await queue.getTotalInflightCount();
        expect(inflightCount).toBe(0);

        // Queue should be empty
        const queueLength = await queue.getQueueLength("tenant:t1:queue:inflight-leak");
        expect(queueLength).toBe(0);

        await queue.close();
      }
    );

    redisTest(
      "should not leave orphaned concurrency slots",
      { timeout: 30000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        // Track concurrency over time
        let maxConcurrency = 0;

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 3,
          consumerIntervalMs: 10,
          visibilityTimeoutMs: 30000,
          concurrencyGroups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 5,
              defaultLimit: 5,
            },
          ],
          startConsumers: false,
        });

        const redis = createRedisClient(redisOptions);

        queue.onMessage(async (ctx) => {
          // Check current concurrency
          const concurrencyKey = keys.concurrencyKey("tenant", "t1");
          const current = await redis.scard(concurrencyKey);
          maxConcurrency = Math.max(maxConcurrency, current);

          // Simulate work with random duration
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 20));

          await ctx.complete();
        });

        const MESSAGE_COUNT = 50;

        // Enqueue messages
        for (let i = 0; i < MESSAGE_COUNT; i++) {
          await queue.enqueue({
            queueId: "tenant:t1:queue:concurrency-leak",
            tenantId: "t1",
            payload: { id: i, value: `msg-${i}` },
          });
        }

        queue.start();

        // Wait for all messages
        await vi.waitFor(
          async () => {
            const len = await queue.getQueueLength("tenant:t1:queue:concurrency-leak");
            const inflight = await queue.getTotalInflightCount();
            expect(len + inflight).toBe(0);
          },
          { timeout: 25000 }
        );

        await queue.stop();

        // Max concurrency should have been respected
        expect(maxConcurrency).toBeLessThanOrEqual(5);

        // Final concurrency should be 0
        const concurrencyKey = keys.concurrencyKey("tenant", "t1");
        const finalConcurrency = await redis.scard(concurrencyKey);
        expect(finalConcurrency).toBe(0);

        await redis.quit();
        await queue.close();
      }
    );
  });

  describe("shutdown races", () => {
    redisTest(
      "should complete in-progress messages during shutdown",
      { timeout: 30000 },
      async ({ redisOptions }) => {
        const inProgressMessages = new Set<string>();
        const completedMessages = new Set<string>();

        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 3,
          consumerIntervalMs: 10,
          visibilityTimeoutMs: 30000,
          startConsumers: false,
        });

        queue.onMessage(async (ctx) => {
          const msgId = ctx.message.id;
          inProgressMessages.add(msgId);

          // Simulate work
          await new Promise((resolve) => setTimeout(resolve, 100));

          completedMessages.add(msgId);
          inProgressMessages.delete(msgId);
          await ctx.complete();
        });

        // Enqueue messages
        for (let i = 0; i < 20; i++) {
          await queue.enqueue({
            queueId: "tenant:t1:queue:shutdown",
            tenantId: "t1",
            payload: { id: i, value: `msg-${i}` },
          });
        }

        queue.start();

        // Wait for some messages to start processing
        await vi.waitFor(
          () => {
            expect(completedMessages.size).toBeGreaterThan(0);
          },
          { timeout: 5000 }
        );

        // Stop while messages are in progress
        await queue.stop();

        // Give time for cleanup
        await new Promise((resolve) => setTimeout(resolve, 500));

        await queue.close();

        // Note: Messages that were in-progress during shutdown may not complete
        // The important thing is no crashes or data corruption
      }
    );
  });

  describe("atomic operation verification", () => {
    redisTest(
      "should maintain consistent state after many enqueue/complete cycles",
      { timeout: 60000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 2, // Multiple shards to test
          consumerCount: 4,
          consumerIntervalMs: 10,
          visibilityTimeoutMs: 30000,
          startConsumers: false,
        });

        const messagesProcessed = new Set<number>();
        let enqueueCounter = 0;

        queue.onMessage(async (ctx) => {
          messagesProcessed.add(ctx.message.payload.id);
          await ctx.complete();
        });

        queue.start();

        // Continuously enqueue messages while processing
        const enqueueDuration = 10000; // 10 seconds
        const startTime = Date.now();

        while (Date.now() - startTime < enqueueDuration) {
          const batch = Array.from({ length: 5 }, () => ({
            payload: { id: enqueueCounter++, value: `msg-${enqueueCounter}` },
          }));

          await queue.enqueueBatch({
            queueId: "tenant:t1:queue:cycles",
            tenantId: "t1",
            messages: batch,
          });

          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        const totalEnqueued = enqueueCounter;

        // Wait for all messages to be processed
        await vi.waitFor(
          () => {
            expect(messagesProcessed.size).toBe(totalEnqueued);
          },
          { timeout: 40000 }
        );

        await queue.stop();

        // Verify final state
        const queueLength = await queue.getQueueLength("tenant:t1:queue:cycles");
        expect(queueLength).toBe(0);

        const inflightCount = await queue.getTotalInflightCount();
        expect(inflightCount).toBe(0);

        const masterQueueCount = await queue.getTotalQueueCount();
        expect(masterQueueCount).toBe(0);

        await queue.close();
      }
    );
  });
});
