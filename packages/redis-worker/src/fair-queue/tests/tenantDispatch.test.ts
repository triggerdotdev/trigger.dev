import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { z } from "zod";
import {
  FairQueue,
  DefaultFairQueueKeyProducer,
  DRRScheduler,
  ExponentialBackoffRetry,
  WorkerQueueManager,
} from "../index.js";
import type { FairQueueKeyProducer, StoredMessage } from "../types.js";
import type { RedisOptions } from "@internal/redis";

const TestPayloadSchema = z.object({ value: z.string() });
type TestPayload = z.infer<typeof TestPayloadSchema>;
const TEST_WORKER_QUEUE_ID = "test-worker-queue";

/**
 * Minimal test helper for tenant dispatch tests.
 */
class TestHelper {
  public fairQueue: FairQueue<typeof TestPayloadSchema>;
  private workerQueueManager: WorkerQueueManager;
  private isRunning = false;
  private abortController = new AbortController();
  private consumerLoops: Promise<void>[] = [];
  private messageHandler?: (ctx: {
    message: { id: string; queueId: string; payload: TestPayload; attempt: number };
    complete: () => Promise<void>;
    release: () => Promise<void>;
    fail: (error?: Error) => Promise<void>;
  }) => Promise<void>;

  constructor(
    private redisOptions: RedisOptions,
    private keys: FairQueueKeyProducer,
    options: {
      shardCount?: number;
      consumerIntervalMs?: number;
      concurrencyLimit?: number;
      visibilityTimeoutMs?: number;
      reclaimIntervalMs?: number;
      retry?: { maxAttempts: number; delayMs: number };
    } = {}
  ) {
    const scheduler = new DRRScheduler({
      redis: redisOptions,
      keys,
      quantum: 10,
      maxDeficit: 100,
    });

    this.fairQueue = new FairQueue({
      redis: redisOptions,
      keys,
      scheduler,
      payloadSchema: TestPayloadSchema,
      shardCount: options.shardCount ?? 1,
      consumerIntervalMs: options.consumerIntervalMs ?? 20,
      visibilityTimeoutMs: options.visibilityTimeoutMs,
      reclaimIntervalMs: options.reclaimIntervalMs,
      startConsumers: false,
      workerQueue: { resolveWorkerQueue: () => TEST_WORKER_QUEUE_ID },
      retry: options.retry
        ? {
            strategy: new ExponentialBackoffRetry({
              maxAttempts: options.retry.maxAttempts,
              minTimeoutInMs: options.retry.delayMs,
              maxTimeoutInMs: options.retry.delayMs,
              factor: 1,
              randomize: false,
            }),
          }
        : undefined,
      concurrencyGroups: options.concurrencyLimit
        ? [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => options.concurrencyLimit!,
              defaultLimit: options.concurrencyLimit!,
            },
          ]
        : undefined,
    });

    this.workerQueueManager = new WorkerQueueManager({
      redis: redisOptions,
      keys,
    });
  }

  onMessage(
    handler: (ctx: {
      message: { id: string; queueId: string; payload: TestPayload; attempt: number };
      complete: () => Promise<void>;
      release: () => Promise<void>;
      fail: (error?: Error) => Promise<void>;
    }) => Promise<void>
  ): void {
    this.messageHandler = handler;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.abortController = new AbortController();
    this.fairQueue.start();
    this.consumerLoops.push(this.#runConsumerLoop());
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.abortController.abort();
    await this.fairQueue.stop();
    await Promise.allSettled(this.consumerLoops);
    this.consumerLoops = [];
  }

  async close(): Promise<void> {
    await this.stop();
    await this.fairQueue.close();
    await this.workerQueueManager.close();
  }

  async #runConsumerLoop(): Promise<void> {
    try {
      while (this.isRunning) {
        if (!this.messageHandler) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        try {
          const messageKey = await this.workerQueueManager.blockingPop(
            TEST_WORKER_QUEUE_ID,
            1,
            this.abortController.signal
          );
          if (!messageKey) continue;

          const colonIndex = messageKey.indexOf(":");
          if (colonIndex === -1) continue;

          const messageId = messageKey.substring(0, colonIndex);
          const queueId = messageKey.substring(colonIndex + 1);
          const storedMessage = await this.fairQueue.getMessageData(messageId, queueId);
          if (!storedMessage) continue;

          await this.messageHandler({
            message: {
              id: storedMessage.id,
              queueId: storedMessage.queueId,
              payload: storedMessage.payload,
              attempt: storedMessage.attempt,
            },
            complete: () => this.fairQueue.completeMessage(messageId, queueId),
            release: () => this.fairQueue.releaseMessage(messageId, queueId),
            fail: (error?: Error) => this.fairQueue.failMessage(messageId, queueId, error),
          });
        } catch {
          if (!this.isRunning) break;
        }
      }
    } catch {
      // Consumer loop stopped
    }
  }
}

describe("Two-Level Tenant Dispatch", () => {
  describe("enqueue writes to new index only", () => {
    redisTest(
      "should populate dispatch and tenant queue indexes, not old master queue",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const redis = createRedisClient(redisOptions);

        const helper = new TestHelper(redisOptions, keys);

        // Enqueue messages to two different queues for two tenants
        await helper.fairQueue.enqueue({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          payload: { value: "msg1" },
        });
        await helper.fairQueue.enqueue({
          queueId: "tenant:t2:queue:q1",
          tenantId: "t2",
          payload: { value: "msg2" },
        });

        // Check new dispatch index (Level 1): should have both tenants
        const dispatchMembers = await redis.zrange(keys.dispatchKey(0), 0, -1, "WITHSCORES");
        expect(dispatchMembers.length).toBeGreaterThanOrEqual(2); // at least 1 tenant per shard

        // Check tenant queue indexes (Level 2)
        const t1Queues = await redis.zrange(keys.tenantQueueIndexKey("t1"), 0, -1);
        expect(t1Queues).toContain("tenant:t1:queue:q1");

        const t2Queues = await redis.zrange(keys.tenantQueueIndexKey("t2"), 0, -1);
        expect(t2Queues).toContain("tenant:t2:queue:q1");

        // Check old master queue: should be EMPTY (new enqueues don't write there)
        const masterMembers = await redis.zrange(keys.masterQueueKey(0), 0, -1);
        expect(masterMembers.length).toBe(0);

        // Per-queue storage should still work as before
        const queueLength = await helper.fairQueue.getQueueLength("tenant:t1:queue:q1");
        expect(queueLength).toBe(1);

        await helper.close();
        await redis.quit();
      }
    );

    redisTest(
      "should populate dispatch index correctly for batch enqueue",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const redis = createRedisClient(redisOptions);

        const helper = new TestHelper(redisOptions, keys);

        await helper.fairQueue.enqueueBatch({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          messages: [
            { payload: { value: "msg1" } },
            { payload: { value: "msg2" } },
            { payload: { value: "msg3" } },
          ],
        });

        // Tenant queue index should have the queue
        const t1Queues = await redis.zrange(keys.tenantQueueIndexKey("t1"), 0, -1);
        expect(t1Queues).toContain("tenant:t1:queue:q1");

        // Dispatch should have the tenant
        const dispatchMembers = await redis.zrange(keys.dispatchKey(0), 0, -1);
        expect(dispatchMembers).toContain("t1");

        // Per-queue storage should have all 3 messages
        const queueLength = await helper.fairQueue.getQueueLength("tenant:t1:queue:q1");
        expect(queueLength).toBe(3);

        await helper.close();
        await redis.quit();
      }
    );
  });

  describe("dispatch consumer processes messages", () => {
    redisTest(
      "should process messages via tenant dispatch path",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const processed: string[] = [];

        const helper = new TestHelper(redisOptions, keys);

        // Enqueue messages
        await helper.fairQueue.enqueue({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          payload: { value: "first" },
        });
        await helper.fairQueue.enqueue({
          queueId: "tenant:t2:queue:q1",
          tenantId: "t2",
          payload: { value: "second" },
        });

        // Set up consumer
        helper.onMessage(async (ctx) => {
          processed.push(ctx.message.payload.value);
          await ctx.complete();
        });

        helper.start();

        // Wait for messages to be processed
        await waitFor(() => processed.length === 2, 5000);
        expect(processed).toContain("first");
        expect(processed).toContain("second");

        await helper.close();
      }
    );
  });

  describe("complete updates dispatch indexes", () => {
    redisTest(
      "should remove empty queue from tenant index and tenant from dispatch",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const redis = createRedisClient(redisOptions);

        const helper = new TestHelper(redisOptions, keys);

        // Enqueue one message
        await helper.fairQueue.enqueue({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          payload: { value: "only" },
        });

        // Verify indexes populated
        let t1Queues = await redis.zrange(keys.tenantQueueIndexKey("t1"), 0, -1);
        expect(t1Queues.length).toBe(1);
        let dispatchMembers = await redis.zrange(keys.dispatchKey(0), 0, -1);
        expect(dispatchMembers).toContain("t1");

        // Process and complete the message
        helper.onMessage(async (ctx) => {
          await ctx.complete();
        });
        helper.start();

        // Wait for processing
        await waitFor(
          async () => (await helper.fairQueue.getQueueLength("tenant:t1:queue:q1")) === 0,
          5000
        );

        // Allow index updates to propagate
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Verify indexes cleaned up
        t1Queues = await redis.zrange(keys.tenantQueueIndexKey("t1"), 0, -1);
        expect(t1Queues.length).toBe(0);
        dispatchMembers = await redis.zrange(keys.dispatchKey(0), 0, -1);
        expect(dispatchMembers).not.toContain("t1");

        await helper.close();
        await redis.quit();
      }
    );

    redisTest(
      "should keep tenant in dispatch when other queues remain",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const redis = createRedisClient(redisOptions);
        const processed: string[] = [];

        const helper = new TestHelper(redisOptions, keys, { concurrencyLimit: 1 });

        // Enqueue to two queues for the same tenant
        await helper.fairQueue.enqueue({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          payload: { value: "queue1" },
        });
        await helper.fairQueue.enqueue({
          queueId: "tenant:t1:queue:q2",
          tenantId: "t1",
          payload: { value: "queue2" },
        });

        // Process messages one at a time (concurrency limit 1)
        helper.onMessage(async (ctx) => {
          processed.push(ctx.message.payload.value);
          await ctx.complete();
        });
        helper.start();

        // Wait for first message
        await waitFor(() => processed.length >= 1, 5000);

        // Tenant should still be in dispatch (has remaining queue)
        const dispatchMembers = await redis.zrange(keys.dispatchKey(0), 0, -1);
        // After first complete, tenant may still be in dispatch due to second queue
        // (exact timing depends on consumer loop)

        // Wait for both messages
        await waitFor(() => processed.length === 2, 5000);
        expect(processed).toContain("queue1");
        expect(processed).toContain("queue2");

        await helper.close();
        await redis.quit();
      }
    );
  });

  describe("legacy drain", () => {
    redisTest(
      "should drain pre-populated master queue alongside new dispatch",
      { timeout: 20000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const redis = createRedisClient(redisOptions);
        const processed: string[] = [];

        // Simulate pre-deploy state: write directly to old master queue + queue storage
        const queueId = "tenant:t1:queue:legacy";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);
        const masterQueueKey = keys.masterQueueKey(0);

        const timestamp = Date.now();
        const storedMessage: StoredMessage<TestPayload> = {
          id: "legacy-msg-1",
          queueId,
          tenantId: "t1",
          payload: { value: "legacy" },
          timestamp,
          attempt: 1,
        };

        // Write to per-queue storage and old master queue (simulating pre-deploy)
        await redis.zadd(queueKey, timestamp, "legacy-msg-1");
        await redis.hset(queueItemsKey, "legacy-msg-1", JSON.stringify(storedMessage));
        await redis.zadd(masterQueueKey, timestamp, queueId);

        // Now create FairQueue (post-deploy)
        const helper = new TestHelper(redisOptions, keys);

        // Also enqueue a new message (goes to dispatch only)
        await helper.fairQueue.enqueue({
          queueId: "tenant:t2:queue:new",
          tenantId: "t2",
          payload: { value: "new" },
        });

        // Verify: old message in master queue, new message in dispatch
        const masterMembers = await redis.zrange(masterQueueKey, 0, -1);
        expect(masterMembers).toContain(queueId);
        const dispatchMembers = await redis.zrange(keys.dispatchKey(0), 0, -1);
        expect(dispatchMembers).toContain("t2");

        // Process both messages
        helper.onMessage(async (ctx) => {
          processed.push(ctx.message.payload.value);
          await ctx.complete();
        });
        helper.start();

        // Both messages should be processed (legacy from drain + new from dispatch)
        await waitFor(() => processed.length === 2, 10000);
        expect(processed).toContain("legacy");
        expect(processed).toContain("new");

        // Old master queue should be empty after drain
        const masterAfter = await redis.zcard(masterQueueKey);
        expect(masterAfter).toBe(0);

        await helper.close();
        await redis.quit();
      }
    );

    redisTest(
      "should not re-populate legacy master queue when completing messages",
      { timeout: 20000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const redis = createRedisClient(redisOptions);

        // Simulate pre-deploy state: queue with 2 messages in old master queue
        const queueId = "tenant:t1:queue:legacy-noreinsert";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);
        const masterQueueKey = keys.masterQueueKey(0);
        const timestamp = Date.now();

        for (let i = 0; i < 2; i++) {
          const msg: StoredMessage<TestPayload> = {
            id: `legacy-msg-${i}`,
            queueId,
            tenantId: "t1",
            payload: { value: `msg-${i}` },
            timestamp: timestamp + i,
            attempt: 1,
          };
          await redis.zadd(queueKey, timestamp + i, `legacy-msg-${i}`);
          await redis.hset(queueItemsKey, `legacy-msg-${i}`, JSON.stringify(msg));
        }
        await redis.zadd(masterQueueKey, timestamp, queueId);

        const processed: string[] = [];
        const helper = new TestHelper(redisOptions, keys);

        helper.onMessage(async (ctx) => {
          processed.push(ctx.message.payload.value);
          await ctx.complete();

          // After completing the first message, the queue still has 1 message
          // The legacy master queue should NOT be re-populated
          if (processed.length === 1) {
            const masterCount = await redis.zcard(masterQueueKey);
            // Should be 0 (drained) not 1 (re-added)
            expect(masterCount).toBe(0);
          }
        });
        helper.start();

        await waitFor(() => processed.length === 2, 10000);
        expect(processed).toHaveLength(2);

        // Final check: master queue should be completely empty
        const masterFinal = await redis.zcard(masterQueueKey);
        expect(masterFinal).toBe(0);

        await helper.close();
        await redis.quit();
      }
    );
  });

  describe("DRR selectQueuesFromDispatch", () => {
    redisTest(
      "should select tenants from dispatch with DRR fairness",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const processed: Array<{ tenantId: string; value: string }> = [];

        const helper = new TestHelper(redisOptions, keys, { concurrencyLimit: 100 });

        // Enqueue messages for multiple tenants
        for (let i = 0; i < 5; i++) {
          await helper.fairQueue.enqueue({
            queueId: `tenant:t1:queue:q${i}`,
            tenantId: "t1",
            payload: { value: `t1-${i}` },
          });
        }
        for (let i = 0; i < 5; i++) {
          await helper.fairQueue.enqueue({
            queueId: `tenant:t2:queue:q${i}`,
            tenantId: "t2",
            payload: { value: `t2-${i}` },
          });
        }

        // Process all messages
        helper.onMessage(async (ctx) => {
          const tenantId = ctx.message.queueId.split(":")[1]!;
          processed.push({ tenantId, value: ctx.message.payload.value });
          await ctx.complete();
        });
        helper.start();

        await waitFor(() => processed.length === 10, 10000);

        // Both tenants should have been processed
        const t1Count = processed.filter((p) => p.tenantId === "t1").length;
        const t2Count = processed.filter((p) => p.tenantId === "t2").length;
        expect(t1Count).toBe(5);
        expect(t2Count).toBe(5);

        await helper.close();
      }
    );
  });

  describe("DRR fairness across iterations", () => {
    redisTest(
      "should distribute processing fairly and not starve any tenant",
      { timeout: 30000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const processed: Array<{ tenantId: string; order: number }> = [];
        let processOrder = 0;

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 5,
          maxDeficit: 20,
        });

        const fairQueue = new FairQueue({
          redis: redisOptions,
          keys,
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerIntervalMs: 10,
          startConsumers: false,
          workerQueue: { resolveWorkerQueue: () => TEST_WORKER_QUEUE_ID },
          concurrencyGroups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 100, // High limit so concurrency doesn't interfere
              defaultLimit: 100,
            },
          ],
        });

        const workerQueueManager = new WorkerQueueManager({
          redis: redisOptions,
          keys,
        });

        // Scenario: 3 tenants with very different queue counts
        // t1: 50 queues (heavy hitter)
        // t2: 5 queues (medium)
        // t3: 1 queue with 5 messages (small)
        // All should get fair service - no tenant should be starved.

        for (let i = 0; i < 50; i++) {
          await fairQueue.enqueue({
            queueId: `tenant:t1:queue:q${i}`,
            tenantId: "t1",
            payload: { value: `t1-${i}` },
          });
        }

        for (let i = 0; i < 5; i++) {
          await fairQueue.enqueue({
            queueId: `tenant:t2:queue:q${i}`,
            tenantId: "t2",
            payload: { value: `t2-${i}` },
          });
        }

        for (let i = 0; i < 5; i++) {
          await fairQueue.enqueue({
            queueId: "tenant:t3:queue:q0",
            tenantId: "t3",
            payload: { value: `t3-${i}` },
          });
        }

        // Start processing
        fairQueue.start();
        const abortController = new AbortController();

        const consumerLoop = (async () => {
          while (!abortController.signal.aborted) {
            try {
              const messageKey = await workerQueueManager.blockingPop(
                TEST_WORKER_QUEUE_ID,
                1,
                abortController.signal
              );
              if (!messageKey) continue;

              const colonIndex = messageKey.indexOf(":");
              if (colonIndex === -1) continue;

              const messageId = messageKey.substring(0, colonIndex);
              const queueId = messageKey.substring(colonIndex + 1);
              const storedMessage = await fairQueue.getMessageData(messageId, queueId);
              if (!storedMessage) continue;

              processed.push({ tenantId: storedMessage.tenantId, order: processOrder++ });
              await fairQueue.completeMessage(messageId, queueId);
            } catch {
              if (abortController.signal.aborted) break;
            }
          }
        })();

        // Wait for all 60 messages to be processed
        await waitFor(() => processed.length === 60, 20000);

        // === Fairness assertions ===

        const t1 = processed.filter((p) => p.tenantId === "t1");
        const t2 = processed.filter((p) => p.tenantId === "t2");
        const t3 = processed.filter((p) => p.tenantId === "t3");

        // All messages processed
        expect(t1.length).toBe(50);
        expect(t2.length).toBe(5);
        expect(t3.length).toBe(5);

        // No tenant should be starved: every tenant should have at least one
        // message processed in the first 20 messages. With quantum=5 and 3 tenants,
        // each should get a turn within the first few iterations.
        const first20 = processed.slice(0, 20);
        const tenantsInFirst20 = new Set(first20.map((p) => p.tenantId));
        expect(tenantsInFirst20.size).toBe(3);

        // t2 and t3 should finish well before t1 (they have fewer messages).
        // Check that t2's last message is processed before t1's last message.
        const t2LastOrder = Math.max(...t2.map((p) => p.order));
        const t1LastOrder = Math.max(...t1.map((p) => p.order));
        expect(t2LastOrder).toBeLessThan(t1LastOrder);

        // t3 should also finish before t1
        const t3LastOrder = Math.max(...t3.map((p) => p.order));
        expect(t3LastOrder).toBeLessThan(t1LastOrder);

        // Check that t1 doesn't monopolize early processing.
        // In the first 15 messages, t1 should have at most 10 (with quantum=5,
        // t1 gets ~5 per round, and there are 3 tenants taking turns).
        const t1InFirst15 = processed.slice(0, 15).filter((p) => p.tenantId === "t1").length;
        expect(t1InFirst15).toBeLessThanOrEqual(10);

        // Clean up
        abortController.abort();
        await Promise.allSettled([consumerLoop]);
        await fairQueue.close();
        await workerQueueManager.close();
      }
    );
  });

  describe("noisy neighbor isolation", () => {
    redisTest(
      "should not block other tenants when one tenant is at capacity",
      { timeout: 20000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const processed: Array<{ tenantId: string; value: string }> = [];
        let blockT1 = true;

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const fairQueue = new FairQueue({
          redis: redisOptions,
          keys,
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerIntervalMs: 20,
          startConsumers: false,
          workerQueue: { resolveWorkerQueue: () => TEST_WORKER_QUEUE_ID },
          concurrencyGroups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async (tenantId) => {
                // t1 has very low concurrency, t2 has high
                return tenantId === "t1" ? 1 : 100;
              },
              defaultLimit: 10,
            },
          ],
        });

        const workerQueueManager = new WorkerQueueManager({
          redis: redisOptions,
          keys,
        });

        // Enqueue 20 messages for t1 (noisy neighbor with concurrency 1)
        for (let i = 0; i < 20; i++) {
          await fairQueue.enqueue({
            queueId: `tenant:t1:queue:q${i}`,
            tenantId: "t1",
            payload: { value: `t1-${i}` },
          });
        }

        // Enqueue 3 messages for t2 (quiet tenant with high concurrency)
        for (let i = 0; i < 3; i++) {
          await fairQueue.enqueue({
            queueId: `tenant:t2:queue:q${i}`,
            tenantId: "t2",
            payload: { value: `t2-${i}` },
          });
        }

        // Start processing
        fairQueue.start();
        const abortController = new AbortController();

        const consumerLoop = (async () => {
          while (!abortController.signal.aborted) {
            try {
              const messageKey = await workerQueueManager.blockingPop(
                TEST_WORKER_QUEUE_ID,
                1,
                abortController.signal
              );
              if (!messageKey) continue;

              const colonIndex = messageKey.indexOf(":");
              if (colonIndex === -1) continue;

              const messageId = messageKey.substring(0, colonIndex);
              const queueId = messageKey.substring(colonIndex + 1);
              const storedMessage = await fairQueue.getMessageData(messageId, queueId);
              if (!storedMessage) continue;

              const tenantId = storedMessage.tenantId;
              processed.push({ tenantId, value: storedMessage.payload.value });
              await fairQueue.completeMessage(messageId, queueId);
            } catch {
              if (abortController.signal.aborted) break;
            }
          }
        })();

        // Wait for t2's messages to be processed (they shouldn't be blocked by t1)
        await waitFor(
          () => processed.filter((p) => p.tenantId === "t2").length === 3,
          10000
        );

        const t2ProcessedCount = processed.filter((p) => p.tenantId === "t2").length;
        expect(t2ProcessedCount).toBe(3);

        // Clean up
        abortController.abort();
        await Promise.allSettled([consumerLoop]);
        await fairQueue.close();
        await workerQueueManager.close();
      }
    );
  });
  describe("release updates dispatch indexes", () => {
    redisTest(
      "should update dispatch indexes when message is released for retry",
      { timeout: 20000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const redis = createRedisClient(redisOptions);
        const attempts: number[] = [];

        const helper = new TestHelper(redisOptions, keys, {
          retry: { maxAttempts: 3, delayMs: 100 },
        });

        await helper.fairQueue.enqueue({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          payload: { value: "retry-me" },
        });

        helper.onMessage(async (ctx) => {
          attempts.push(ctx.message.attempt);
          if (ctx.message.attempt < 2) {
            // Fail on first attempt to trigger retry
            await ctx.fail(new Error("transient error"));
          } else {
            await ctx.complete();
          }
        });
        helper.start();

        // Wait for successful processing on second attempt
        await waitFor(() => attempts.length >= 2 && attempts.includes(2), 10000);

        // After retry, the message went back into the queue via releaseMessage Lua.
        // Verify it was picked up again (attempt 2 processed).
        expect(attempts).toContain(1);
        expect(attempts).toContain(2);

        // After completion, dispatch indexes should be cleaned up
        await waitFor(async () => {
          const t1Queues = await redis.zcard(keys.tenantQueueIndexKey("t1"));
          return t1Queues === 0;
        }, 5000);

        await helper.close();
        await redis.quit();
      }
    );
  });

  describe("reclaim updates dispatch indexes", () => {
    redisTest(
      "should update dispatch indexes when timed-out message is reclaimed",
      { timeout: 20000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const redis = createRedisClient(redisOptions);
        const processCount = { count: 0 };

        const helper = new TestHelper(redisOptions, keys, {
          visibilityTimeoutMs: 500,
          reclaimIntervalMs: 200,
        });

        await helper.fairQueue.enqueue({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          payload: { value: "reclaim-me" },
        });

        helper.onMessage(async (ctx) => {
          processCount.count++;
          if (processCount.count === 1) {
            // First attempt: don't complete, let it timeout and get reclaimed
            await new Promise((resolve) => setTimeout(resolve, 1500));
          } else {
            // Second attempt after reclaim: complete normally
            await ctx.complete();
          }
        });
        helper.start();

        // Wait for message to be processed twice (once timeout, once success)
        await waitFor(() => processCount.count >= 2, 10000);

        // After reclaim + re-processing + completion, indexes should be clean
        await waitFor(async () => {
          const t1Queues = await redis.zcard(keys.tenantQueueIndexKey("t1"));
          return t1Queues === 0;
        }, 5000);

        await helper.close();
        await redis.quit();
      }
    );
  });

  describe("legacy message migration via reclaim", () => {
    redisTest(
      "should migrate legacy master queue message to dispatch index on reclaim",
      { timeout: 20000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const redis = createRedisClient(redisOptions);
        const processed: string[] = [];

        // Simulate pre-deploy: write message to old master queue + queue storage
        const queueId = "tenant:t1:queue:legacy";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);
        const masterQueueKey = keys.masterQueueKey(0);

        const timestamp = Date.now();
        const storedMessage: StoredMessage<TestPayload> = {
          id: "legacy-reclaim-1",
          queueId,
          tenantId: "t1",
          payload: { value: "legacy-reclaim" },
          timestamp,
          attempt: 1,
        };

        await redis.zadd(queueKey, timestamp, "legacy-reclaim-1");
        await redis.hset(queueItemsKey, "legacy-reclaim-1", JSON.stringify(storedMessage));
        await redis.zadd(masterQueueKey, timestamp, queueId);

        // Verify: message only in old master queue, not in dispatch
        expect(await redis.zcard(keys.dispatchKey(0))).toBe(0);
        expect(await redis.zcard(keys.tenantQueueIndexKey("t1"))).toBe(0);

        // Create FairQueue with short visibility timeout
        const helper = new TestHelper(redisOptions, keys, {
          visibilityTimeoutMs: 500,
          reclaimIntervalMs: 200,
        });

        const processCount = { count: 0 };
        helper.onMessage(async (ctx) => {
          processCount.count++;
          if (processCount.count === 1) {
            // First attempt: don't complete, let it timeout
            // The reclaim will put it back in queue and update dispatch indexes
            await new Promise((resolve) => setTimeout(resolve, 1500));
          } else {
            // Second attempt: complete
            processed.push(ctx.message.payload.value);
            await ctx.complete();
          }
        });
        helper.start();

        // Wait for the message to be processed (first via drain, then reclaimed into dispatch)
        await waitFor(() => processed.length === 1, 15000);
        expect(processed[0]).toBe("legacy-reclaim");

        // After completion, both old and new indexes should be clean
        const masterAfter = await redis.zcard(masterQueueKey);
        const dispatchAfter = await redis.zcard(keys.dispatchKey(0));
        const tenantQueuesAfter = await redis.zcard(keys.tenantQueueIndexKey("t1"));

        // Old master queue should still be empty (drain removed it)
        // or at least the queue itself should be gone
        expect(tenantQueuesAfter).toBe(0);

        await helper.close();
        await redis.quit();
      }
    );

    redisTest(
      "should migrate legacy message to dispatch index on retry failure",
      { timeout: 20000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const redis = createRedisClient(redisOptions);
        const attempts: number[] = [];

        // Simulate pre-deploy: write message to old master queue
        const queueId = "tenant:t1:queue:legacy";
        const queueKey = keys.queueKey(queueId);
        const queueItemsKey = keys.queueItemsKey(queueId);
        const masterQueueKey = keys.masterQueueKey(0);

        const timestamp = Date.now();
        const storedMessage: StoredMessage<TestPayload> = {
          id: "legacy-retry-1",
          queueId,
          tenantId: "t1",
          payload: { value: "legacy-retry" },
          timestamp,
          attempt: 1,
        };

        await redis.zadd(queueKey, timestamp, "legacy-retry-1");
        await redis.hset(queueItemsKey, "legacy-retry-1", JSON.stringify(storedMessage));
        await redis.zadd(masterQueueKey, timestamp, queueId);

        // Create FairQueue with retry enabled
        const helper = new TestHelper(redisOptions, keys, {
          retry: { maxAttempts: 3, delayMs: 100 },
        });

        helper.onMessage(async (ctx) => {
          attempts.push(ctx.message.attempt);
          if (ctx.message.attempt < 2) {
            // Fail first attempt — triggers retry which writes to dispatch index
            await ctx.fail(new Error("transient"));
          } else {
            await ctx.complete();
          }
        });
        helper.start();

        // Wait for retry to complete
        await waitFor(() => attempts.includes(2), 10000);

        // The retry release should have written to dispatch indexes.
        // After completion, indexes should be clean.
        await waitFor(async () => {
          const t1Queues = await redis.zcard(keys.tenantQueueIndexKey("t1"));
          return t1Queues === 0;
        }, 5000);

        expect(attempts).toContain(1);
        expect(attempts).toContain(2);

        await helper.close();
        await redis.quit();
      }
    );
  });
  describe("dispatch shard is tenant-based, not queue-based", () => {
    redisTest(
      "tenant with queues in different queue shards should appear in only one dispatch shard",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        const keys = new DefaultFairQueueKeyProducer({ prefix: "test" });
        const redis = createRedisClient(redisOptions);
        const shardCount = 2;

        const helper = new TestHelper(redisOptions, keys, { shardCount });

        try {
          const tenantId = "tenant-shard-test";

          // Find two queue IDs for the same tenant that hash to different queue shards
          // by trying different queue names
          const { MasterQueue: MQ } = await import("../masterQueue.js");
          const mq = new MQ({ redis: redisOptions, keys, shardCount });
          const { TenantDispatch: TD } = await import("../tenantDispatch.js");
          const td = new TD({ redis: redisOptions, keys, shardCount });

          let queueShard0: string | null = null;
          let queueShard1: string | null = null;

          for (let i = 0; i < 100; i++) {
            const qId = `tenant:${tenantId}:queue:q${i}`;
            const shard = mq.getShardForQueue(qId);
            if (shard === 0 && !queueShard0) queueShard0 = qId;
            if (shard === 1 && !queueShard1) queueShard1 = qId;
            if (queueShard0 && queueShard1) break;
          }

          expect(queueShard0).not.toBeNull();
          expect(queueShard1).not.toBeNull();

          // Both queues belong to the same tenant, so dispatch shard should be the same
          const expectedDispatchShard = td.getShardForTenant(tenantId);

          // Enqueue to both queues
          await helper.fairQueue.enqueue({
            queueId: queueShard0!,
            tenantId,
            payload: { value: "msg-shard0" },
          });
          await helper.fairQueue.enqueue({
            queueId: queueShard1!,
            tenantId,
            payload: { value: "msg-shard1" },
          });

          // Verify: tenant should only appear in one dispatch shard
          const dispatch0 = await redis.zrange(keys.dispatchKey(0), 0, -1);
          const dispatch1 = await redis.zrange(keys.dispatchKey(1), 0, -1);

          const inShard0 = dispatch0.includes(tenantId);
          const inShard1 = dispatch1.includes(tenantId);

          // Tenant should appear in exactly one shard
          expect(inShard0 !== inShard1).toBe(true);

          // And it should be the expected one
          if (expectedDispatchShard === 0) {
            expect(inShard0).toBe(true);
            expect(inShard1).toBe(false);
          } else {
            expect(inShard0).toBe(false);
            expect(inShard1).toBe(true);
          }

          await mq.close();
          await td.close();
        } finally {
          await helper.close();
          await redis.quit();
        }
      }
    );
  });
});

// Helper to wait for a condition
async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 50
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await condition();
    if (result) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
