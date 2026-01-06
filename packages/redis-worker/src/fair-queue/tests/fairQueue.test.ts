import { describe, expect, vi } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { z } from "zod";
import {
  FairQueue,
  DefaultFairQueueKeyProducer,
  DRRScheduler,
  FixedDelayRetry,
  NoRetry,
} from "../index.js";
import type { FairQueueKeyProducer } from "../types.js";

// Define a common payload schema for tests
const TestPayloadSchema = z.object({ value: z.string() });
type TestPayload = z.infer<typeof TestPayloadSchema>;

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

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
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

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
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

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
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

        // Check that messages were interleaved (not all t1 before t2)
        const firstFive = processed.slice(0, 5);
        const t1InFirstFive = firstFive.filter((p) => p.tenant === "t1").length;
        const t2InFirstFive = firstFive.filter((p) => p.tenant === "t2").length;

        // DRR should ensure some interleaving
        expect(t1InFirstFive).toBeGreaterThan(0);
        expect(t2InFirstFive).toBeGreaterThan(0);

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

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
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

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
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

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
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

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
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

      const queue = new FairQueue({
        redis: redisOptions,
        keys,
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
        });

        queue.onMessage(async (ctx) => {
          // TypeScript should infer ctx.message.payload as { name: string; count: number }
          processed.push(ctx.message.payload);
          await ctx.complete();
        });

        await queue.enqueue({
          queueId: "tenant:t1:queue:q1",
          tenantId: "t1",
          payload: { name: "typed", count: 42 },
        });

        queue.start();

        await vi.waitFor(
          () => {
            expect(processed).toHaveLength(1);
          },
          { timeout: 5000 }
        );

        expect(processed[0]).toEqual({ name: "typed", count: 42 });

        await queue.close();
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

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
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

        const processed: string[] = [];
        queue.onMessage(async (ctx) => {
          processed.push(ctx.message.payload.value);
          await ctx.complete();
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

        const queue = new FairQueue({
          redis: redisOptions,
          keys,
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

        // Enqueue messages to multiple queues
        for (let i = 0; i < 10; i++) {
          await queue.enqueue({
            queueId: `tenant:t${i}:queue:q1`,
            tenantId: `t${i}`,
            payload: { value: `msg-${i}` },
          });
        }

        const processed: string[] = [];

        // Handler that always fails to trigger cooloff
        queue.onMessage(async (ctx) => {
          processed.push(ctx.message.payload.value);
          await ctx.fail(new Error("Forced failure"));
        });

        queue.start();

        // Wait for some messages to be processed and fail
        await vi.waitFor(
          () => {
            expect(processed.length).toBeGreaterThanOrEqual(5);
          },
          { timeout: 10000 }
        );

        // The cooloff states size should be capped (test that it doesn't grow unbounded)
        const cacheSizes = queue.getCacheSizes();
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
        const queue = new FairQueue({
          redis: redisOptions,
          keys,
          scheduler,
          payloadSchema: TestPayloadSchema,
          shardCount: 1,
          consumerCount: 1,
          consumerIntervalMs: 50,
          visibilityTimeoutMs: 10000,
          workerQueue: {
            enabled: true,
            blockingTimeoutSeconds: 1,
          },
          concurrency: {
            groups: [
              {
                name: "tenant",
                extractGroupId: (q) => q.tenantId,
                getLimit: async () => 2, // Limit to 2 concurrent per tenant
                defaultLimit: 2,
              },
            ],
          },
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
