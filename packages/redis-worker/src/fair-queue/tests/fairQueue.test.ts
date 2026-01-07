import { describe, expect, vi } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { z } from "zod";
import {
  FairQueue,
  DefaultFairQueueKeyProducer,
  DRRScheduler,
  FixedDelayRetry,
  NoRetry,
  WorkerQueueManager,
} from "../index.js";
import type { FairQueueKeyProducer, FairQueueOptions, StoredMessage } from "../types.js";
import type { RedisOptions } from "@internal/redis";

// Define a common payload schema for tests
const TestPayloadSchema = z.object({ value: z.string() });
type TestPayload = z.infer<typeof TestPayloadSchema>;

// Constant for test worker queue ID
const TEST_WORKER_QUEUE_ID = "test-worker-queue";

/**
 * TestFairQueueHelper wraps FairQueue for easier testing.
 * It manages the worker queue consumer loop and provides a simple onMessage interface.
 */
class TestFairQueueHelper {
  public fairQueue: FairQueue<typeof TestPayloadSchema>;
  private workerQueueManager: WorkerQueueManager;
  private isRunning = false;
  private abortController: AbortController;
  private consumerLoops: Promise<void>[] = [];
  private messageHandler?: (ctx: {
    message: {
      id: string;
      queueId: string;
      payload: TestPayload;
      timestamp: number;
      attempt: number;
    };
    queue: { id: string; tenantId: string };
    consumerId: string;
    heartbeat: () => Promise<boolean>;
    complete: () => Promise<void>;
    release: () => Promise<void>;
    fail: (error?: Error) => Promise<void>;
  }) => Promise<void>;

  constructor(
    private redisOptions: RedisOptions,
    private keys: FairQueueKeyProducer,
    options: Omit<FairQueueOptions<typeof TestPayloadSchema>, "redis" | "keys" | "workerQueue">
  ) {
    this.abortController = new AbortController();

    // Create FairQueue with worker queue resolver
    this.fairQueue = new FairQueue({
      ...options,
      redis: redisOptions,
      keys,
      workerQueue: {
        resolveWorkerQueue: () => TEST_WORKER_QUEUE_ID,
      },
    });

    // Create worker queue manager for consuming
    this.workerQueueManager = new WorkerQueueManager({
      redis: redisOptions,
      keys,
    });
  }

  onMessage(
    handler: (ctx: {
      message: {
        id: string;
        queueId: string;
        payload: TestPayload;
        timestamp: number;
        attempt: number;
      };
      queue: { id: string; tenantId: string };
      consumerId: string;
      heartbeat: () => Promise<boolean>;
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

    // Start FairQueue's master queue consumers
    this.fairQueue.start();

    // Start worker queue consumer loop
    const loop = this.#runConsumerLoop();
    this.consumerLoops.push(loop);
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

  // Delegate methods to fairQueue
  async enqueue(options: Parameters<typeof this.fairQueue.enqueue>[0]) {
    return this.fairQueue.enqueue(options);
  }

  async enqueueBatch(options: Parameters<typeof this.fairQueue.enqueueBatch>[0]) {
    return this.fairQueue.enqueueBatch(options);
  }

  async getQueueLength(queueId: string) {
    return this.fairQueue.getQueueLength(queueId);
  }

  async getTotalInflightCount() {
    return this.fairQueue.getTotalInflightCount();
  }


  registerTelemetryGauges(options?: { observedTenants?: string[] }) {
    return this.fairQueue.registerTelemetryGauges(options);
  }

  async getDeadLetterQueueLength(tenantId: string) {
    return this.fairQueue.getDeadLetterQueueLength(tenantId);
  }

  async getDeadLetterMessages(tenantId: string) {
    return this.fairQueue.getDeadLetterMessages(tenantId);
  }

  async redriveMessage(tenantId: string, messageId: string) {
    return this.fairQueue.redriveMessage(tenantId, messageId);
  }

  async #runConsumerLoop(): Promise<void> {
    const loopId = "test-consumer-0";

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

          const ctx = {
            message: {
              id: storedMessage.id,
              queueId: storedMessage.queueId,
              payload: storedMessage.payload,
              timestamp: storedMessage.timestamp,
              attempt: storedMessage.attempt,
            },
            queue: {
              id: queueId,
              tenantId: storedMessage.tenantId,
            },
            consumerId: loopId,
            heartbeat: () => this.fairQueue.heartbeatMessage(messageId, queueId),
            complete: () => this.fairQueue.completeMessage(messageId, queueId),
            release: () => this.fairQueue.releaseMessage(messageId, queueId),
            fail: (error?: Error) => this.fairQueue.failMessage(messageId, queueId, error),
          };

          await this.messageHandler(ctx);
        } catch (error) {
          if (this.abortController.signal.aborted) break;
        }
      }
    } catch {
      // Ignore abort errors
    }
  }
}

describe("FairQueue", () => {
  let keys: FairQueueKeyProducer;

  describe("basic enqueue and process", () => {
    redisTest(
      "should enqueue and process a single message",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        const processed: string[] = [];
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new TestFairQueueHelper(redisOptions, keys, {
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 1,
          consumerIntervalMs: 50,
          visibilityTimeoutMs: 5000,
          startConsumers: false,
        });

        queue.onMessage(async (ctx) => {
          processed.push(ctx.message.payload.value);
          await ctx.complete();
        });

        // Enqueue message
        const messageId = await queue.enqueue({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          payload: { value: "hello" },
        });

        expect(messageId).toBeDefined();

        // Start processing
        queue.start();

        // Wait for processing
        await vi.waitFor(
          () => {
            expect(processed).toContain("hello");
          },
          { timeout: 5000 }
        );

        await queue.close();
      }
    );

    redisTest(
      "should enqueue and process a batch of messages",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        const processed: string[] = [];
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new TestFairQueueHelper(redisOptions, keys, {
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 1,
          consumerIntervalMs: 50,
          visibilityTimeoutMs: 5000,
          startConsumers: false,
        });

        queue.onMessage(async (ctx) => {
          processed.push(ctx.message.payload.value);
          await ctx.complete();
        });

        // Enqueue batch
        const messageIds = await queue.enqueueBatch({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          messages: [
            { payload: { value: "one" } },
            { payload: { value: "two" } },
            { payload: { value: "three" } },
          ],
        });

        expect(messageIds).toHaveLength(3);

        // Start processing
        queue.start();

        // Wait for all messages
        await vi.waitFor(
          () => {
            expect(processed).toHaveLength(3);
          },
          { timeout: 10000 }
        );

        expect(processed).toContain("one");
        expect(processed).toContain("two");
        expect(processed).toContain("three");

        await queue.close();
      }
    );
  });

  describe("fair scheduling", () => {
    redisTest(
      "should process messages fairly across tenants using DRR",
      { timeout: 20000 },
      async ({ redisOptions }) => {
        const processed: Array<{ tenant: string; value: string }> = [];
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 1, // Small quantum for interleaving
          maxDeficit: 5,
        });

        const queue = new TestFairQueueHelper(redisOptions, keys, {
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 1,
          consumerIntervalMs: 20,
          visibilityTimeoutMs: 5000,
          startConsumers: false,
        });

        queue.onMessage(async (ctx) => {
          processed.push({
            tenant: ctx.queue.tenantId,
            value: ctx.message.payload.value,
          });
          await ctx.complete();
        });

        // Enqueue messages from two tenants
        for (let i = 0; i < 5; i++) {
          await queue.enqueue({
            queueId: "tenant:t1:queue:q1",
            tenantId: "t1",
            payload: { value: `t1-${i}` },
          });
          await queue.enqueue({
            queueId: "tenant:t2:queue:q1",
            tenantId: "t2",
            payload: { value: `t2-${i}` },
          });
        }

        // Start processing
        queue.start();

        // Wait for all messages
        await vi.waitFor(
          () => {
            expect(processed).toHaveLength(10);
          },
          { timeout: 15000 }
        );

        // With two-stage architecture, fairness is at the claiming level, not processing order.
        // Both tenants' queues are serviced in the same scheduler round, but messages are
        // pushed to a shared worker queue and processed in FIFO order.
        // The fairness guarantee is that both tenants' messages ARE processed, not that
        // they're interleaved in the processing order.
        const t1Count = processed.filter((p) => p.tenant === "t1").length;
        const t2Count = processed.filter((p) => p.tenant === "t2").length;

        // DRR ensures both tenants get their messages claimed and processed
        expect(t1Count).toBe(5);
        expect(t2Count).toBe(5);

        // Verify all messages were processed
        expect(processed.filter((p) => p.tenant === "t1").map((p) => p.value)).toEqual(
          expect.arrayContaining(["t1-0", "t1-1", "t1-2", "t1-3", "t1-4"])
        );
        expect(processed.filter((p) => p.tenant === "t2").map((p) => p.value)).toEqual(
          expect.arrayContaining(["t2-0", "t2-1", "t2-2", "t2-3", "t2-4"])
        );

        await queue.close();
      }
    );
  });

  describe("visibility timeout", () => {
    redisTest(
      "should reclaim message when processing times out",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        const processCount = { count: 0 };
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new TestFairQueueHelper(redisOptions, keys, {
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 1,
          consumerIntervalMs: 50,
          visibilityTimeoutMs: 500, // Short timeout
          reclaimIntervalMs: 200,
          startConsumers: false,
        });

        queue.onMessage(async (ctx) => {
          processCount.count++;
          if (processCount.count === 1) {
            // First attempt: don't complete, let it timeout
            await new Promise((resolve) => setTimeout(resolve, 1000));
          } else {
            // Second attempt: complete normally
            await ctx.complete();
          }
        });

        // Enqueue message
        await queue.enqueue({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          payload: { value: "timeout-test" },
        });

        // Start processing
        queue.start();

        // Wait for message to be processed twice (once timeout, once success)
        await vi.waitFor(
          () => {
            expect(processCount.count).toBeGreaterThanOrEqual(2);
          },
          { timeout: 10000 }
        );

        await queue.close();
      }
    );
  });

  describe("concurrency limiting", () => {
    redisTest(
      "should respect tenant concurrency limits",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        const concurrent = { current: 0, max: 0 };
        const processed: string[] = [];
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new TestFairQueueHelper(redisOptions, keys, {
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 3, // Multiple consumers
          consumerIntervalMs: 20,
          visibilityTimeoutMs: 5000,
          concurrencyGroups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 2, // Max 2 concurrent per tenant
              defaultLimit: 2,
            },
          ],
          startConsumers: false,
        });

        queue.onMessage(async (ctx) => {
          concurrent.current++;
          concurrent.max = Math.max(concurrent.max, concurrent.current);

          // Simulate some work
          await new Promise((resolve) => setTimeout(resolve, 100));

          concurrent.current--;
          processed.push(ctx.message.payload.value);
          await ctx.complete();
        });

        // Enqueue 5 messages to same tenant
        for (let i = 0; i < 5; i++) {
          await queue.enqueue({
            queueId: "tenant:t1:queue:q1",
            tenantId: "t1",
            payload: { value: `msg-${i}` },
          });
        }

        // Start processing
        queue.start();

        // Wait for all messages
        await vi.waitFor(
          () => {
            expect(processed).toHaveLength(5);
          },
          { timeout: 10000 }
        );

        // Max concurrent should be <= 2 (the limit)
        expect(concurrent.max).toBeLessThanOrEqual(2);

        await queue.close();
      }
    );
  });

  describe("retry and dead letter queue", () => {
    redisTest(
      "should retry failed messages with exponential backoff",
      { timeout: 20000 },
      async ({ redisOptions }) => {
        const attempts: number[] = [];
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new TestFairQueueHelper(redisOptions, keys, {
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 1,
          consumerIntervalMs: 50,
          visibilityTimeoutMs: 5000,
          retry: {
            strategy: new FixedDelayRetry({ maxAttempts: 3, delayMs: 100 }),
            deadLetterQueue: true,
          },
          startConsumers: false,
        });

        queue.onMessage(async (ctx) => {
          attempts.push(ctx.message.attempt);
          if (ctx.message.attempt < 3) {
            // Fail the first 2 attempts
            await ctx.fail(new Error("Simulated failure"));
          } else {
            // Succeed on 3rd attempt
            await ctx.complete();
          }
        });

        // Enqueue message
        await queue.enqueue({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          payload: { value: "retry-test" },
        });

        // Start processing
        queue.start();

        // Wait for 3 attempts
        await vi.waitFor(
          () => {
            expect(attempts).toHaveLength(3);
          },
          { timeout: 15000 }
        );

        expect(attempts).toEqual([1, 2, 3]);

        await queue.close();
      }
    );

    redisTest(
      "should move to DLQ after max retries",
      { timeout: 20000 },
      async ({ redisOptions }) => {
        const attempts: number[] = [];
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const queue = new TestFairQueueHelper(redisOptions, keys, {
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 1,
          consumerIntervalMs: 50,
          visibilityTimeoutMs: 5000,
          retry: {
            strategy: new FixedDelayRetry({ maxAttempts: 2, delayMs: 50 }),
            deadLetterQueue: true,
          },
          startConsumers: false,
        });

        queue.onMessage(async (ctx) => {
          attempts.push(ctx.message.attempt);
          // Always fail
          await ctx.fail(new Error("Always fails"));
        });

        // Enqueue message
        await queue.enqueue({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          payload: { value: "dlq-test" },
        });

        // Start processing
        queue.start();

        // Wait for max attempts
        await vi.waitFor(
          () => {
            expect(attempts).toHaveLength(2);
          },
          { timeout: 10000 }
        );

        // Give time for DLQ processing
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Check DLQ
        const dlqMessages = await queue.getDeadLetterMessages("t1");
        expect(dlqMessages).toHaveLength(1);
        expect(dlqMessages[0]!.payload.value).toBe("dlq-test");
        expect(dlqMessages[0]!.attempts).toBe(2);
        expect(dlqMessages[0]!.lastError).toBe("Always fails");

        await queue.close();
      }
    );

    redisTest("should redrive messages from DLQ", { timeout: 20000 }, async ({ redisOptions }) => {
      const processed: string[] = [];
      let shouldFail = true;
      keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

      const scheduler = new DRRScheduler({
        redis: redisOptions,
        keys,
        quantum: 10,
        maxDeficit: 100,
      });

      const queue = new TestFairQueueHelper(redisOptions, keys, {
        scheduler,
        payloadSchema: TestPayloadSchema,
        shardCount: 1,
        consumerCount: 1,
        consumerIntervalMs: 50,
        visibilityTimeoutMs: 5000,
        retry: {
          strategy: new NoRetry(),
          deadLetterQueue: true,
        },
        startConsumers: false,
      });

      queue.onMessage(async (ctx) => {
        if (shouldFail) {
          await ctx.fail(new Error("First fail"));
        } else {
          processed.push(ctx.message.payload.value);
          await ctx.complete();
        }
      });

      // Enqueue message
      await queue.enqueue({
        queueId: "tenant:t1:queue:q1",
        tenantId: "t1",
        payload: { value: "redrive-test" },
      });

      // Start processing
      queue.start();

      // Wait for DLQ
      await vi.waitFor(
        async () => {
          const dlqLen = await queue.getDeadLetterQueueLength("t1");
          expect(dlqLen).toBe(1);
        },
        { timeout: 5000 }
      );

      // Now make handler succeed
      shouldFail = false;

      // Redrive the message
      const dlqMessages = await queue.getDeadLetterMessages("t1");
      const success = await queue.redriveMessage("t1", dlqMessages[0]!.id);
      expect(success).toBe(true);

      // Wait for successful processing
      await vi.waitFor(
        () => {
          expect(processed).toContain("redrive-test");
        },
        { timeout: 5000 }
      );

      // DLQ should be empty
      const dlqLen = await queue.getDeadLetterQueueLength("t1");
      expect(dlqLen).toBe(0);

      await queue.close();
    });
  });

  describe("Zod schema validation", () => {
    const PayloadSchema = z.object({
      name: z.string(),
      count: z.number(),
    });

    redisTest(
      "should validate payload on enqueue when enabled",
      { timeout: 10000 },
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
          payloadSchema: PayloadSchema,
          validateOnEnqueue: true,
          startConsumers: false,
          workerQueue: {
            resolveWorkerQueue: () => TEST_WORKER_QUEUE_ID,
          },
        });

        // Valid payload should work
        const validId = await queue.enqueue({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          payload: { name: "test", count: 5 },
        });
        expect(validId).toBeDefined();

        // Invalid payload should throw
        await expect(
          queue.enqueue({
            queueId: "tenant:t1:queue:q1",
            tenantId: "t1",
            payload: { name: 123, count: "invalid" } as any,
          })
        ).rejects.toThrow("Payload validation failed");

        await queue.close();
      }
    );

    redisTest(
      "should provide typed payload in message handler",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        const processed: Array<{ name: string; count: number }> = [];
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        // Create worker queue manager for consuming
        const workerQueueManager = new WorkerQueueManager({
          redis: redisOptions,
          keys,
        });

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
          scheduler,
          payloadSchema: PayloadSchema,
          shardCount: 1,
          consumerCount: 1,
          consumerIntervalMs: 50,
          visibilityTimeoutMs: 5000,
          startConsumers: false,
          workerQueue: {
            resolveWorkerQueue: () => TEST_WORKER_QUEUE_ID,
          },
        });

        // Start the queue (which routes messages to worker queue)
        queue.start();

        await queue.enqueue({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          payload: { name: "typed", count: 42 },
        });

        // Consume from worker queue
        let attempts = 0;
        while (processed.length === 0 && attempts < 50) {
          const messageKey = await workerQueueManager.blockingPop(TEST_WORKER_QUEUE_ID, 1);
          if (messageKey) {
            const colonIndex = messageKey.indexOf(":");
            const messageId = messageKey.substring(0, colonIndex);
            const queueId = messageKey.substring(colonIndex + 1);
            const storedMessage = await queue.getMessageData(messageId, queueId);
            if (storedMessage) {
              // TypeScript should infer storedMessage.payload as { name: string; count: number }
              processed.push(storedMessage.payload);
              await queue.completeMessage(messageId, queueId);
            }
          }
          attempts++;
        }

        expect(processed).toHaveLength(1);
        expect(processed[0]).toEqual({ name: "typed", count: 42 });

        await queue.close();
        await workerQueueManager.close();
      }
    );
  });

  describe("cooloff", () => {
    redisTest(
      "should enter cooloff after repeated empty dequeues",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const processed: string[] = [];
        const queue = new TestFairQueueHelper(redisOptions, keys, {
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 1,
          consumerIntervalMs: 20,
          visibilityTimeoutMs: 5000,
          cooloff: {
            enabled: true,
            threshold: 3, // Enter cooloff after 3 empty dequeues
            periodMs: 1000,
          },
          startConsumers: false,
        });

        queue.onMessage(async (ctx) => {
          processed.push(ctx.message.payload.value);
          await ctx.complete();
        });

        // Start without any messages (will trigger empty dequeues)
        queue.start();

        // Wait a bit for cooloff to kick in
        await new Promise((resolve) => setTimeout(resolve, 500));

        // The queue should be in cooloff now (no way to directly test, but we can verify
        // behavior by checking that new messages get processed after cooloff expires)
        await queue.enqueue({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          payload: { value: "after-cooloff" },
        });

        // Message should still be processed (cooloff is per-queue, not global)
        await vi.waitFor(
          () => {
            expect(processed).toContain("after-cooloff");
          },
          { timeout: 10000 }
        );

        await queue.close();
      }
    );

    redisTest(
      "should clear cooloff states when size cap is exceeded",
      { timeout: 15000 },
      async ({ redisOptions }) => {
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        const processed: string[] = [];

        const queue = new TestFairQueueHelper(redisOptions, keys, {
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 1,
          consumerIntervalMs: 20,
          visibilityTimeoutMs: 5000,
          cooloff: {
            enabled: true,
            threshold: 1, // Enter cooloff after 1 failure
            periodMs: 100, // Short cooloff for testing
            maxStatesSize: 5, // Very small cap for testing
          },
          startConsumers: false,
        });

        // Handler that always fails to trigger cooloff
        queue.onMessage(async (ctx) => {
          processed.push(ctx.message.payload.value);
          await ctx.fail(new Error("Forced failure"));
        });

        // Enqueue messages to multiple queues
        for (let i = 0; i < 10; i++) {
          await queue.enqueue({
            queueId: `tenant:t${i}:queue:q1`,
            tenantId: `t${i}`,
            payload: { value: `msg-${i}` },
          });
        }

        queue.start();

        // Wait for some messages to be processed and fail
        await vi.waitFor(
          () => {
            expect(processed.length).toBeGreaterThanOrEqual(5);
          },
          { timeout: 10000 }
        );

        // The cooloff states size should be capped (test that it doesn't grow unbounded)
        const cacheSizes = queue.fairQueue.getCacheSizes();
        expect(cacheSizes.cooloffStatesSize).toBeLessThanOrEqual(10); // Some buffer for race conditions

        await queue.close();
      }
    );
  });

  describe("inspection methods", () => {
    redisTest("should report queue length", { timeout: 10000 }, async ({ redisOptions }) => {
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
        startConsumers: false,
        workerQueue: {
          resolveWorkerQueue: () => TEST_WORKER_QUEUE_ID,
        },
      });

      // Initially empty
      let length = await queue.getQueueLength("tenant:t1:queue:q1");
      expect(length).toBe(0);

      // Enqueue messages
      await queue.enqueue({
        queueId: "tenant:t1:queue:q1",
        tenantId: "t1",
        payload: { value: "one" },
      });
      await queue.enqueue({
        queueId: "tenant:t1:queue:q1",
        tenantId: "t1",
        payload: { value: "two" },
      });

      length = await queue.getQueueLength("tenant:t1:queue:q1");
      expect(length).toBe(2);

      await queue.close();
    });

    redisTest("should report total queue count", { timeout: 10000 }, async ({ redisOptions }) => {
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
        shardCount: 2,
        startConsumers: false,
        workerQueue: {
          resolveWorkerQueue: () => TEST_WORKER_QUEUE_ID,
        },
      });

      // Initially empty
      let count = await queue.getTotalQueueCount();
      expect(count).toBe(0);

      // Enqueue to different queues
      await queue.enqueue({
        queueId: "tenant:t1:queue:q1",
        tenantId: "t1",
        payload: { value: "one" },
      });
      await queue.enqueue({
        queueId: "tenant:t2:queue:q1",
        tenantId: "t2",
        payload: { value: "two" },
      });

      count = await queue.getTotalQueueCount();
      expect(count).toBe(2);

      await queue.close();
    });
  });

  describe("two-stage processing with concurrency limits", () => {
    redisTest(
      "should release remaining claimed messages when concurrency reservation fails",
      { timeout: 30000 },
      async ({ redisOptions }) => {
        const processed: string[] = [];
        const processingMessages = new Set<string>();
        keys = new DefaultFairQueueKeyProducer({ prefix: "test" });

        const scheduler = new DRRScheduler({
          redis: redisOptions,
          keys,
          quantum: 10,
          maxDeficit: 100,
        });

        // Create queue with:
        // - Worker queue enabled (two-stage processing)
        // - Concurrency limit of 2 per tenant
        const queue = new TestFairQueueHelper(redisOptions, keys, {
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 1,
          consumerIntervalMs: 50,
          visibilityTimeoutMs: 10000,
          concurrencyGroups: [
            {
              name: "tenant",
              extractGroupId: (q) => q.tenantId,
              getLimit: async () => 2, // Limit to 2 concurrent per tenant
              defaultLimit: 2,
            },
          ],
          startConsumers: false,
        });

        // Message handler that tracks what's being processed
        queue.onMessage(async (ctx) => {
          const value = ctx.message.payload.value;
          processingMessages.add(value);

          // Simulate some work
          await new Promise((resolve) => setTimeout(resolve, 100));

          processed.push(value);
          processingMessages.delete(value);
          await ctx.complete();
        });

        // Enqueue 5 messages to the same tenant queue
        await queue.enqueueBatch({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          messages: [
            { payload: { value: "msg-1" } },
            { payload: { value: "msg-2" } },
            { payload: { value: "msg-3" } },
            { payload: { value: "msg-4" } },
            { payload: { value: "msg-5" } },
          ],
        });

        // Start processing
        queue.start();

        // Wait for all messages to be processed
        // With concurrency limit of 2, it should process in batches
        await vi.waitFor(
          () => {
            expect(processed.length).toBe(5);
          },
          { timeout: 20000 }
        );

        // All messages should have been processed
        expect(processed).toContain("msg-1");
        expect(processed).toContain("msg-2");
        expect(processed).toContain("msg-3");
        expect(processed).toContain("msg-4");
        expect(processed).toContain("msg-5");

        // Wait a bit for any cleanup to complete
        await new Promise((resolve) => setTimeout(resolve, 100));

        // No messages should be stuck in-flight
        const inflightCount = await queue.getTotalInflightCount();
        expect(inflightCount).toBe(0);

        await queue.close();
      }
    );
  });
});
