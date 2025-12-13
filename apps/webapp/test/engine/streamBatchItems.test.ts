import { describe, expect, vi } from "vitest";

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
import { StreamBatchItemsService } from "../../app/runEngine/services/streamBatchItems.server";
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

