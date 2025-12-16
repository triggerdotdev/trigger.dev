import { describe, expect, it, vi } from "vitest";

// Mock the db prisma client - needs to be before other imports
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getEntitlement: vi.fn(),
  };
});

import { RunEngine } from "@internal/run-engine";
import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import { trace } from "@opentelemetry/api";
import { PrismaClient } from "@trigger.dev/database";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import {
  StreamBatchItemsService,
  createNdjsonParserStream,
  streamToAsyncIterable,
} from "../../app/runEngine/services/streamBatchItems.server";
import { ServiceValidationError } from "../../app/v3/services/baseService.server";

vi.setConfig({ testTimeout: 30_000 }); // 30 seconds timeout

describe("StreamBatchItemsService", () => {
  /**
   * Helper to create a batch directly in the database
   */
  async function createBatch(
    prisma: PrismaClient,
    environmentId: string,
    options: {
      runCount: number;
      status?: "PENDING" | "PROCESSING" | "COMPLETED" | "ABORTED";
      sealed?: boolean;
    }
  ) {
    const { id, friendlyId } = BatchId.generate();

    const batch = await prisma.batchTaskRun.create({
      data: {
        id,
        friendlyId,
        runtimeEnvironmentId: environmentId,
        status: options.status ?? "PENDING",
        runCount: options.runCount,
        expectedCount: options.runCount,
        runIds: [],
        batchVersion: "runengine:v2",
        sealed: options.sealed ?? false,
      },
    });

    return batch;
  }

  /**
   * Helper to create an async iterable from items
   */
  async function* itemsToAsyncIterable(
    items: Array<{ task: string; payload: string; index: number }>
  ) {
    for (const item of items) {
      yield item;
    }
  }

  containerTest(
    "should seal batch successfully when no race condition",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
          disabled: true,
        },
        queue: {
          redis: redisOptions,
        },
        runLock: {
          redis: redisOptions,
        },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": {
              name: "small-1x" as const,
              cpu: 0.5,
              memory: 0.5,
              centsPerMs: 0.0001,
            },
          },
          baseCostInCents: 0.0005,
        },
        batchQueue: {
          redis: redisOptions,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // Create a batch
      const batch = await createBatch(prisma, authenticatedEnvironment.id, {
        runCount: 2,
        status: "PENDING",
        sealed: false,
      });

      // Initialize the batch in Redis
      await engine.initializeBatch({
        batchId: batch.id,
        friendlyId: batch.friendlyId,
        environmentId: authenticatedEnvironment.id,
        environmentType: authenticatedEnvironment.type,
        organizationId: authenticatedEnvironment.organizationId,
        projectId: authenticatedEnvironment.projectId,
        runCount: 2,
        processingConcurrency: 10,
      });

      // Enqueue items directly to Redis (bypassing the service's item processing)
      await engine.enqueueBatchItem(batch.id, authenticatedEnvironment.id, 0, {
        task: "test-task",
        payload: JSON.stringify({ data: "item1" }),
        payloadType: "application/json",
      });
      await engine.enqueueBatchItem(batch.id, authenticatedEnvironment.id, 1, {
        task: "test-task",
        payload: JSON.stringify({ data: "item2" }),
        payloadType: "application/json",
      });

      // Create service with our test engine and prisma
      const service = new StreamBatchItemsService({
        prisma,
        engine,
      });

      // Create an empty items iterator since items are already enqueued
      const items = itemsToAsyncIterable([]);

      const result = await service.call(authenticatedEnvironment, batch.friendlyId, items, {
        maxItemBytes: 1024 * 1024,
      });

      expect(result.sealed).toBe(true);
      expect(result.id).toBe(batch.friendlyId);

      // Verify the batch is sealed in the database
      const updatedBatch = await prisma.batchTaskRun.findUnique({
        where: { id: batch.id },
      });

      expect(updatedBatch?.sealed).toBe(true);
      expect(updatedBatch?.status).toBe("PROCESSING");
      expect(updatedBatch?.sealedAt).toBeDefined();
      expect(updatedBatch?.processingStartedAt).toBeDefined();

      await engine.quit();
    }
  );

  containerTest(
    "should handle race condition when batch already sealed by another request",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
          disabled: true,
        },
        queue: {
          redis: redisOptions,
        },
        runLock: {
          redis: redisOptions,
        },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": {
              name: "small-1x" as const,
              cpu: 0.5,
              memory: 0.5,
              centsPerMs: 0.0001,
            },
          },
          baseCostInCents: 0.0005,
        },
        batchQueue: {
          redis: redisOptions,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // Create a batch that is already sealed and PROCESSING (simulating another request won the race)
      const batch = await createBatch(prisma, authenticatedEnvironment.id, {
        runCount: 2,
        status: "PROCESSING",
        sealed: true,
      });

      // Initialize the batch in Redis with full count
      await engine.initializeBatch({
        batchId: batch.id,
        friendlyId: batch.friendlyId,
        environmentId: authenticatedEnvironment.id,
        environmentType: authenticatedEnvironment.type,
        organizationId: authenticatedEnvironment.organizationId,
        projectId: authenticatedEnvironment.projectId,
        runCount: 2,
        processingConcurrency: 10,
      });

      // Enqueue items directly
      await engine.enqueueBatchItem(batch.id, authenticatedEnvironment.id, 0, {
        task: "test-task",
        payload: JSON.stringify({ data: "item1" }),
        payloadType: "application/json",
      });
      await engine.enqueueBatchItem(batch.id, authenticatedEnvironment.id, 1, {
        task: "test-task",
        payload: JSON.stringify({ data: "item2" }),
        payloadType: "application/json",
      });

      const service = new StreamBatchItemsService({
        prisma,
        engine,
      });

      // This should fail because the batch is already sealed
      await expect(
        service.call(authenticatedEnvironment, batch.friendlyId, itemsToAsyncIterable([]), {
          maxItemBytes: 1024 * 1024,
        })
      ).rejects.toThrow(ServiceValidationError);

      await engine.quit();
    }
  );

  containerTest(
    "should return sealed=true when concurrent request already sealed the batch during seal attempt",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
          disabled: true,
        },
        queue: {
          redis: redisOptions,
        },
        runLock: {
          redis: redisOptions,
        },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": {
              name: "small-1x" as const,
              cpu: 0.5,
              memory: 0.5,
              centsPerMs: 0.0001,
            },
          },
          baseCostInCents: 0.0005,
        },
        batchQueue: {
          redis: redisOptions,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // Create a batch in PENDING state
      const batch = await createBatch(prisma, authenticatedEnvironment.id, {
        runCount: 2,
        status: "PENDING",
        sealed: false,
      });

      // Initialize the batch in Redis
      await engine.initializeBatch({
        batchId: batch.id,
        friendlyId: batch.friendlyId,
        environmentId: authenticatedEnvironment.id,
        environmentType: authenticatedEnvironment.type,
        organizationId: authenticatedEnvironment.organizationId,
        projectId: authenticatedEnvironment.projectId,
        runCount: 2,
        processingConcurrency: 10,
      });

      // Enqueue items
      await engine.enqueueBatchItem(batch.id, authenticatedEnvironment.id, 0, {
        task: "test-task",
        payload: JSON.stringify({ data: "item1" }),
        payloadType: "application/json",
      });
      await engine.enqueueBatchItem(batch.id, authenticatedEnvironment.id, 1, {
        task: "test-task",
        payload: JSON.stringify({ data: "item2" }),
        payloadType: "application/json",
      });

      // Create a custom prisma client that simulates a race condition:
      // When updateMany is called on batchTaskRun, it returns count: 0 (as if another request beat us)
      // but the subsequent findUnique shows the batch is sealed and PROCESSING
      const racingPrisma = {
        ...prisma,
        batchTaskRun: {
          ...prisma.batchTaskRun,
          findFirst: prisma.batchTaskRun.findFirst.bind(prisma.batchTaskRun),
          updateMany: async () => {
            // Simulate another request winning the race - seal the batch first
            await prisma.batchTaskRun.update({
              where: { id: batch.id },
              data: {
                sealed: true,
                sealedAt: new Date(),
                status: "PROCESSING",
                processingStartedAt: new Date(),
              },
            });
            // Return 0 as if the conditional update failed
            return { count: 0 };
          },
          findUnique: prisma.batchTaskRun.findUnique.bind(prisma.batchTaskRun),
        },
      } as unknown as PrismaClient;

      const service = new StreamBatchItemsService({
        prisma: racingPrisma,
        engine,
      });

      // Call the service - it should detect the race and return success since batch is sealed
      const result = await service.call(
        authenticatedEnvironment,
        batch.friendlyId,
        itemsToAsyncIterable([]),
        {
          maxItemBytes: 1024 * 1024,
        }
      );

      // Should return sealed=true because the batch was sealed (by the "other" request)
      expect(result.sealed).toBe(true);
      expect(result.id).toBe(batch.friendlyId);

      // Verify the batch is sealed in the database
      const updatedBatch = await prisma.batchTaskRun.findUnique({
        where: { id: batch.id },
      });

      expect(updatedBatch?.sealed).toBe(true);
      expect(updatedBatch?.status).toBe("PROCESSING");

      await engine.quit();
    }
  );

  containerTest(
    "should throw error when race condition leaves batch in unexpected state",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
          disabled: true,
        },
        queue: {
          redis: redisOptions,
        },
        runLock: {
          redis: redisOptions,
        },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": {
              name: "small-1x" as const,
              cpu: 0.5,
              memory: 0.5,
              centsPerMs: 0.0001,
            },
          },
          baseCostInCents: 0.0005,
        },
        batchQueue: {
          redis: redisOptions,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // Create a batch in PENDING state
      const batch = await createBatch(prisma, authenticatedEnvironment.id, {
        runCount: 2,
        status: "PENDING",
        sealed: false,
      });

      // Initialize the batch in Redis
      await engine.initializeBatch({
        batchId: batch.id,
        friendlyId: batch.friendlyId,
        environmentId: authenticatedEnvironment.id,
        environmentType: authenticatedEnvironment.type,
        organizationId: authenticatedEnvironment.organizationId,
        projectId: authenticatedEnvironment.projectId,
        runCount: 2,
        processingConcurrency: 10,
      });

      // Enqueue items
      await engine.enqueueBatchItem(batch.id, authenticatedEnvironment.id, 0, {
        task: "test-task",
        payload: JSON.stringify({ data: "item1" }),
        payloadType: "application/json",
      });
      await engine.enqueueBatchItem(batch.id, authenticatedEnvironment.id, 1, {
        task: "test-task",
        payload: JSON.stringify({ data: "item2" }),
        payloadType: "application/json",
      });

      // Create a custom prisma client that simulates a race condition where
      // the batch ends up in an unexpected state (ABORTED instead of PROCESSING)
      const racingPrisma = {
        ...prisma,
        batchTaskRun: {
          ...prisma.batchTaskRun,
          findFirst: prisma.batchTaskRun.findFirst.bind(prisma.batchTaskRun),
          updateMany: async () => {
            // Simulate the batch being aborted by another process
            await prisma.batchTaskRun.update({
              where: { id: batch.id },
              data: {
                sealed: true,
                status: "ABORTED",
              },
            });
            // Return 0 as if the conditional update failed
            return { count: 0 };
          },
          findUnique: prisma.batchTaskRun.findUnique.bind(prisma.batchTaskRun),
        },
      } as unknown as PrismaClient;

      const service = new StreamBatchItemsService({
        prisma: racingPrisma,
        engine,
      });

      // Call the service - it should throw because the batch is in an unexpected state
      await expect(
        service.call(authenticatedEnvironment, batch.friendlyId, itemsToAsyncIterable([]), {
          maxItemBytes: 1024 * 1024,
        })
      ).rejects.toThrow(/unexpected state/);

      await engine.quit();
    }
  );

  containerTest(
    "should return sealed=false when item count does not match",
    async ({ prisma, redisOptions }) => {
      const engine = new RunEngine({
        prisma,
        worker: {
          redis: redisOptions,
          workers: 1,
          tasksPerWorker: 10,
          pollIntervalMs: 100,
          disabled: true,
        },
        queue: {
          redis: redisOptions,
        },
        runLock: {
          redis: redisOptions,
        },
        machines: {
          defaultMachine: "small-1x",
          machines: {
            "small-1x": {
              name: "small-1x" as const,
              cpu: 0.5,
              memory: 0.5,
              centsPerMs: 0.0001,
            },
          },
          baseCostInCents: 0.0005,
        },
        batchQueue: {
          redis: redisOptions,
        },
        tracer: trace.getTracer("test", "0.0.0"),
      });

      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

      // Create a batch expecting 3 items
      const batch = await createBatch(prisma, authenticatedEnvironment.id, {
        runCount: 3,
        status: "PENDING",
        sealed: false,
      });

      // Initialize the batch in Redis
      await engine.initializeBatch({
        batchId: batch.id,
        friendlyId: batch.friendlyId,
        environmentId: authenticatedEnvironment.id,
        environmentType: authenticatedEnvironment.type,
        organizationId: authenticatedEnvironment.organizationId,
        projectId: authenticatedEnvironment.projectId,
        runCount: 3,
        processingConcurrency: 10,
      });

      // Only enqueue 2 items (1 short of expected)
      await engine.enqueueBatchItem(batch.id, authenticatedEnvironment.id, 0, {
        task: "test-task",
        payload: JSON.stringify({ data: "item1" }),
        payloadType: "application/json",
      });
      await engine.enqueueBatchItem(batch.id, authenticatedEnvironment.id, 1, {
        task: "test-task",
        payload: JSON.stringify({ data: "item2" }),
        payloadType: "application/json",
      });

      const service = new StreamBatchItemsService({
        prisma,
        engine,
      });

      const result = await service.call(
        authenticatedEnvironment,
        batch.friendlyId,
        itemsToAsyncIterable([]),
        {
          maxItemBytes: 1024 * 1024,
        }
      );

      // Should return sealed=false because item count doesn't match
      expect(result.sealed).toBe(false);
      expect(result.enqueuedCount).toBe(2);
      expect(result.expectedCount).toBe(3);

      // Verify the batch is NOT sealed in the database
      const updatedBatch = await prisma.batchTaskRun.findUnique({
        where: { id: batch.id },
      });

      expect(updatedBatch?.sealed).toBe(false);
      expect(updatedBatch?.status).toBe("PENDING");

      await engine.quit();
    }
  );
});

describe("createNdjsonParserStream", () => {
  /**
   * Helper to collect all items from a ReadableStream
   */
  async function collectStream<T>(stream: ReadableStream<T>): Promise<T[]> {
    const results: T[] = [];
    for await (const item of streamToAsyncIterable(stream)) {
      results.push(item);
    }
    return results;
  }

  /**
   * Helper to create a ReadableStream from an array of Uint8Array chunks
   */
  function chunksToStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream({
      pull(controller) {
        if (index < chunks.length) {
          controller.enqueue(chunks[index++]);
        } else {
          controller.close();
        }
      },
    });
  }

  it("should parse basic NDJSON correctly", async () => {
    const ndjson = '{"name":"alice"}\n{"name":"bob"}\n{"name":"charlie"}\n';
    const encoder = new TextEncoder();
    const stream = chunksToStream([encoder.encode(ndjson)]);

    const parser = createNdjsonParserStream(1024);
    const results = await collectStream(stream.pipeThrough(parser));

    expect(results).toEqual([{ name: "alice" }, { name: "bob" }, { name: "charlie" }]);
  });

  it("should handle NDJSON without trailing newline", async () => {
    const ndjson = '{"id":1}\n{"id":2}';
    const encoder = new TextEncoder();
    const stream = chunksToStream([encoder.encode(ndjson)]);

    const parser = createNdjsonParserStream(1024);
    const results = await collectStream(stream.pipeThrough(parser));

    expect(results).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("should skip empty lines", async () => {
    const ndjson = '{"a":1}\n\n{"b":2}\n   \n{"c":3}\n';
    const encoder = new TextEncoder();
    const stream = chunksToStream([encoder.encode(ndjson)]);

    const parser = createNdjsonParserStream(1024);
    const results = await collectStream(stream.pipeThrough(parser));

    expect(results).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("should handle chunks split mid-line", async () => {
    // Split '{"split":"value"}\n' across multiple chunks
    const encoder = new TextEncoder();
    const chunks = [encoder.encode('{"spl'), encoder.encode('it":"va'), encoder.encode('lue"}\n')];
    const stream = chunksToStream(chunks);

    const parser = createNdjsonParserStream(1024);
    const results = await collectStream(stream.pipeThrough(parser));

    expect(results).toEqual([{ split: "value" }]);
  });

  it("should handle multibyte UTF-8 characters split across chunks", async () => {
    // Test with emoji and other multibyte characters
    // The emoji "😀" is 4 bytes: 0xF0 0x9F 0x98 0x80
    const json = '{"emoji":"😀"}\n';
    const fullBytes = new TextEncoder().encode(json);

    // Split in the middle of the emoji (between byte 2 and 3 of the 4-byte sequence)
    // Find where the emoji starts
    const emojiStart = fullBytes.indexOf(0xf0);
    expect(emojiStart).toBeGreaterThan(0);

    // Split after first 2 bytes of the emoji
    const chunk1 = fullBytes.slice(0, emojiStart + 2);
    const chunk2 = fullBytes.slice(emojiStart + 2);

    const stream = chunksToStream([chunk1, chunk2]);
    const parser = createNdjsonParserStream(1024);
    const results = await collectStream(stream.pipeThrough(parser));

    expect(results).toEqual([{ emoji: "😀" }]);
  });

  it("should handle multiple multibyte characters across chunks", async () => {
    // Japanese text: "こんにちは" (each hiragana is 3 bytes in UTF-8)
    const json = '{"greeting":"こんにちは"}\n';
    const fullBytes = new TextEncoder().encode(json);

    // Split into many small chunks to stress test UTF-8 handling
    const chunkSize = 3; // Deliberately misaligned with UTF-8 boundaries
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < fullBytes.length; i += chunkSize) {
      chunks.push(fullBytes.slice(i, i + chunkSize));
    }

    const stream = chunksToStream(chunks);
    const parser = createNdjsonParserStream(1024);
    const results = await collectStream(stream.pipeThrough(parser));

    expect(results).toEqual([{ greeting: "こんにちは" }]);
  });

  it("should reject lines exceeding maxItemBytes", async () => {
    const maxBytes = 50;
    // Create a line that exceeds the limit
    const largeJson = JSON.stringify({ data: "x".repeat(100) }) + "\n";
    const encoder = new TextEncoder();
    const stream = chunksToStream([encoder.encode(largeJson)]);

    const parser = createNdjsonParserStream(maxBytes);

    await expect(collectStream(stream.pipeThrough(parser))).rejects.toThrow(/exceeds maximum size/);
  });

  it("should reject unbounded accumulation without newlines", async () => {
    const maxBytes = 50;
    // Send data without any newlines that exceeds the buffer limit
    const encoder = new TextEncoder();
    const chunks = [
      encoder.encode('{"start":"'),
      encoder.encode("x".repeat(60)), // This will push buffer over 50 bytes
    ];
    const stream = chunksToStream(chunks);

    const parser = createNdjsonParserStream(maxBytes);

    await expect(collectStream(stream.pipeThrough(parser))).rejects.toThrow(
      /exceeds maximum size.*no newline found/
    );
  });

  it("should check byte size before decoding to prevent OOM", async () => {
    // This test verifies that size is checked on raw bytes, not decoded string length
    // Unicode characters like "🎉" are 4 bytes but 2 UTF-16 code units (string length 2)
    const maxBytes = 30;

    // Create a line with emojis - each emoji is 4 bytes
    // {"e":"🎉🎉🎉🎉🎉"} = 5 + 20 (5 emojis * 4 bytes) + 2 = 27 bytes - should pass
    const smallJson = '{"e":"🎉🎉🎉🎉🎉"}\n';
    const smallBytes = new TextEncoder().encode(smallJson);
    expect(smallBytes.length).toBeLessThan(maxBytes);

    // {"e":"🎉🎉🎉🎉🎉🎉🎉"} = 7 emojis * 4 bytes + overhead = 35 bytes - should fail
    const largeJson = '{"e":"🎉🎉🎉🎉🎉🎉🎉"}\n';
    const largeBytes = new TextEncoder().encode(largeJson);
    expect(largeBytes.length).toBeGreaterThan(maxBytes);

    // Small one should succeed
    const stream1 = chunksToStream([smallBytes]);
    const parser1 = createNdjsonParserStream(maxBytes);
    const results1 = await collectStream(stream1.pipeThrough(parser1));
    expect(results1).toHaveLength(1);

    // Large one should fail
    const stream2 = chunksToStream([largeBytes]);
    const parser2 = createNdjsonParserStream(maxBytes);
    await expect(collectStream(stream2.pipeThrough(parser2))).rejects.toThrow(/exceeds maximum/);
  });

  it("should handle final line in flush without trailing newline", async () => {
    const ndjson = '{"first":1}\n{"second":2}'; // No trailing newline
    const encoder = new TextEncoder();
    const stream = chunksToStream([encoder.encode(ndjson)]);

    const parser = createNdjsonParserStream(1024);
    const results = await collectStream(stream.pipeThrough(parser));

    expect(results).toEqual([{ first: 1 }, { second: 2 }]);
  });

  it("should reject invalid JSON", async () => {
    const ndjson = '{"valid":true}\n{invalid json}\n';
    const encoder = new TextEncoder();
    const stream = chunksToStream([encoder.encode(ndjson)]);

    const parser = createNdjsonParserStream(1024);

    await expect(collectStream(stream.pipeThrough(parser))).rejects.toThrow(
      /Invalid JSON at line 2/
    );
  });

  it("should reject invalid UTF-8 sequences", async () => {
    // Invalid UTF-8: 0xFF is never valid in UTF-8
    const invalidBytes = new Uint8Array([
      0x7b,
      0x22,
      0x78,
      0x22,
      0x3a,
      0xff,
      0x7d,
      0x0a, // {"x":�}\n with invalid byte
    ]);
    const stream = chunksToStream([invalidBytes]);

    const parser = createNdjsonParserStream(1024);

    await expect(collectStream(stream.pipeThrough(parser))).rejects.toThrow(/Invalid UTF-8/);
  });

  it("should handle many small chunks efficiently", async () => {
    // Simulate streaming byte-by-byte
    const json = '{"test":"value"}\n';
    const bytes = new TextEncoder().encode(json);
    const chunks = Array.from(bytes).map((b) => new Uint8Array([b]));

    const stream = chunksToStream(chunks);
    const parser = createNdjsonParserStream(1024);
    const results = await collectStream(stream.pipeThrough(parser));

    expect(results).toEqual([{ test: "value" }]);
  });

  it("should handle multiple lines per chunk", async () => {
    const ndjson = '{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}\n{"e":5}\n';
    const encoder = new TextEncoder();
    const stream = chunksToStream([encoder.encode(ndjson)]);

    const parser = createNdjsonParserStream(1024);
    const results = await collectStream(stream.pipeThrough(parser));

    expect(results).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }, { e: 5 }]);
  });

  it("should handle empty stream", async () => {
    const stream = chunksToStream([]);

    const parser = createNdjsonParserStream(1024);
    const results = await collectStream(stream.pipeThrough(parser));

    expect(results).toEqual([]);
  });

  it("should handle stream with only whitespace", async () => {
    const encoder = new TextEncoder();
    const stream = chunksToStream([encoder.encode("   \n\n   \n")]);

    const parser = createNdjsonParserStream(1024);
    const results = await collectStream(stream.pipeThrough(parser));

    expect(results).toEqual([]);
  });
});
