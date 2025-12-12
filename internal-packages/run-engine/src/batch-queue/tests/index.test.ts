import { redisTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { BatchQueue } from "../index.js";
import type { CompleteBatchResult, InitializeBatchOptions, BatchItem } from "../types.js";

vi.setConfig({ testTimeout: 60_000 });

describe("BatchQueue", () => {
  function createBatchQueue(
    redisContainer: { getHost: () => string; getPort: () => number },
    options?: { startConsumers?: boolean }
  ) {
    return new BatchQueue({
      redis: {
        host: redisContainer.getHost(),
        port: redisContainer.getPort(),
        keyPrefix: "test:",
      },
      drr: {
        quantum: 5,
        maxDeficit: 50,
      },
      consumerCount: 1,
      consumerIntervalMs: 50,
      startConsumers: options?.startConsumers ?? false, // Don't start by default in tests
    });
  }

  function createInitOptions(
    batchId: string,
    envId: string,
    runCount: number
  ): InitializeBatchOptions {
    return {
      batchId,
      friendlyId: `friendly_${batchId}`,
      environmentId: envId,
      environmentType: "DEVELOPMENT",
      organizationId: "org123",
      projectId: "proj123",
      runCount,
    };
  }

  function createBatchItems(count: number): BatchItem[] {
    return Array.from({ length: count }, (_, i) => ({
      task: `task-${i}`,
      payload: JSON.stringify({ index: i }),
      payloadType: "application/json",
      options: { tags: [`tag-${i}`] },
    }));
  }

  async function enqueueItems(
    queue: BatchQueue,
    batchId: string,
    envId: string,
    items: BatchItem[]
  ): Promise<void> {
    for (let i = 0; i < items.length; i++) {
      await queue.enqueueBatchItem(batchId, envId, i, items[i]);
    }
  }

  describe("initializeBatch + enqueueBatchItem (2-phase API)", () => {
    redisTest("should initialize a batch successfully", async ({ redisContainer }) => {
      const queue = createBatchQueue(redisContainer);
      try {
        const options = createInitOptions("batch1", "env1", 5);
        await queue.initializeBatch(options);

        // Verify batch metadata was stored
        const meta = await queue.getBatchMeta("batch1");
        expect(meta).not.toBeNull();
        expect(meta?.batchId).toBe("batch1");
        expect(meta?.environmentId).toBe("env1");
        expect(meta?.runCount).toBe(5);
      } finally {
        await queue.close();
      }
    });

    redisTest("should enqueue items and track remaining count", async ({ redisContainer }) => {
      const queue = createBatchQueue(redisContainer);
      try {
        await queue.initializeBatch(createInitOptions("batch1", "env1", 10));
        const items = createBatchItems(10);
        await enqueueItems(queue, "batch1", "env1", items);

        const count = await queue.getBatchRemainingCount("batch1");
        expect(count).toBe(10);
      } finally {
        await queue.close();
      }
    });

    redisTest("should enqueue multiple batches", async ({ redisContainer }) => {
      const queue = createBatchQueue(redisContainer);
      try {
        await queue.initializeBatch(createInitOptions("batch1", "env1", 5));
        await queue.initializeBatch(createInitOptions("batch2", "env1", 3));
        await queue.initializeBatch(createInitOptions("batch3", "env2", 7));

        await enqueueItems(queue, "batch1", "env1", createBatchItems(5));
        await enqueueItems(queue, "batch2", "env1", createBatchItems(3));
        await enqueueItems(queue, "batch3", "env2", createBatchItems(7));

        expect(await queue.getBatchRemainingCount("batch1")).toBe(5);
        expect(await queue.getBatchRemainingCount("batch2")).toBe(3);
        expect(await queue.getBatchRemainingCount("batch3")).toBe(7);
      } finally {
        await queue.close();
      }
    });

    redisTest("should store batch metadata correctly", async ({ redisContainer }) => {
      const queue = createBatchQueue(redisContainer);
      try {
        const options: InitializeBatchOptions = {
          batchId: "batch1",
          friendlyId: "batch_abc123",
          environmentId: "env1",
          environmentType: "PRODUCTION",
          organizationId: "org456",
          projectId: "proj789",
          runCount: 1,
          parentRunId: "run_parent",
          resumeParentOnCompletion: true,
          triggerVersion: "1.0.0",
          spanParentAsLink: true,
          idempotencyKey: "idem123",
        };

        await queue.initializeBatch(options);
        await queue.enqueueBatchItem("batch1", "env1", 0, {
          task: "my-task",
          payload: '{"data": true}',
        });

        const meta = await queue.getBatchMeta("batch1");
        expect(meta).not.toBeNull();
        expect(meta?.friendlyId).toBe("batch_abc123");
        expect(meta?.environmentType).toBe("PRODUCTION");
        expect(meta?.organizationId).toBe("org456");
        expect(meta?.projectId).toBe("proj789");
        expect(meta?.parentRunId).toBe("run_parent");
        expect(meta?.resumeParentOnCompletion).toBe(true);
        expect(meta?.triggerVersion).toBe("1.0.0");
        expect(meta?.spanParentAsLink).toBe(true);
        expect(meta?.idempotencyKey).toBe("idem123");
      } finally {
        await queue.close();
      }
    });

    redisTest("should deduplicate items with same index", async ({ redisContainer }) => {
      const queue = createBatchQueue(redisContainer);
      try {
        await queue.initializeBatch(createInitOptions("batch1", "env1", 2));

        const item: BatchItem = { task: "task-0", payload: '{"index": 0}' };

        // First enqueue should succeed
        const result1 = await queue.enqueueBatchItem("batch1", "env1", 0, item);
        expect(result1.enqueued).toBe(true);

        // Second enqueue with same index should be deduplicated
        const result2 = await queue.enqueueBatchItem("batch1", "env1", 0, item);
        expect(result2.enqueued).toBe(false);

        // Different index should succeed
        const result3 = await queue.enqueueBatchItem("batch1", "env1", 1, item);
        expect(result3.enqueued).toBe(true);
      } finally {
        await queue.close();
      }
    });
  });

  describe("processing callbacks", () => {
    redisTest("should call process callback for each item", async ({ redisContainer }) => {
      const queue = createBatchQueue(redisContainer, { startConsumers: true });
      const processedItems: Array<{ batchId: string; itemIndex: number; task: string }> = [];
      let completionResult: CompleteBatchResult | null = null;

      try {
        // Set up callbacks
        queue.onProcessItem(async ({ batchId, itemIndex, item }) => {
          processedItems.push({ batchId, itemIndex, task: item.task });
          return { success: true, runId: `run_${itemIndex}` };
        });

        queue.onBatchComplete(async (result) => {
          completionResult = result;
        });

        // Initialize and enqueue a small batch
        await queue.initializeBatch(createInitOptions("batch1", "env1", 3));
        await enqueueItems(queue, "batch1", "env1", createBatchItems(3));

        // Wait for processing
        await vi.waitFor(
          () => {
            expect(completionResult).not.toBeNull();
          },
          { timeout: 5000 }
        );

        // Verify all items were processed
        expect(processedItems).toHaveLength(3);
        expect(processedItems.map((p) => p.itemIndex).sort()).toEqual([0, 1, 2]);

        // Verify completion result
        expect(completionResult!.batchId).toBe("batch1");
        expect(completionResult!.successfulRunCount).toBe(3);
        expect(completionResult!.failedRunCount).toBe(0);
        expect(completionResult!.runIds).toEqual(["run_0", "run_1", "run_2"]);
      } finally {
        await queue.close();
      }
    });

    redisTest("should handle processing failures", async ({ redisContainer }) => {
      const queue = createBatchQueue(redisContainer, { startConsumers: true });
      let completionResult: CompleteBatchResult | null = null;

      try {
        // Set up callbacks - fail item 1
        queue.onProcessItem(async ({ itemIndex }) => {
          if (itemIndex === 1) {
            return { success: false, error: "Task failed", errorCode: "TASK_ERROR" };
          }
          return { success: true, runId: `run_${itemIndex}` };
        });

        queue.onBatchComplete(async (result) => {
          completionResult = result;
        });

        await queue.initializeBatch(createInitOptions("batch1", "env1", 3));
        await enqueueItems(queue, "batch1", "env1", createBatchItems(3));

        await vi.waitFor(
          () => {
            expect(completionResult).not.toBeNull();
          },
          { timeout: 5000 }
        );

        // Verify mixed results
        expect(completionResult!.successfulRunCount).toBe(2);
        expect(completionResult!.failedRunCount).toBe(1);
        expect(completionResult!.failures).toHaveLength(1);
        expect(completionResult!.failures[0].index).toBe(1);
        expect(completionResult!.failures[0].error).toBe("Task failed");
        expect(completionResult!.failures[0].errorCode).toBe("TASK_ERROR");
      } finally {
        await queue.close();
      }
    });

    redisTest("should handle callback exceptions", async ({ redisContainer }) => {
      const queue = createBatchQueue(redisContainer, { startConsumers: true });
      let completionResult: CompleteBatchResult | null = null;

      try {
        // Set up callbacks - throw exception on item 0
        queue.onProcessItem(async ({ itemIndex }) => {
          if (itemIndex === 0) {
            throw new Error("Unexpected error");
          }
          return { success: true, runId: `run_${itemIndex}` };
        });

        queue.onBatchComplete(async (result) => {
          completionResult = result;
        });

        await queue.initializeBatch(createInitOptions("batch1", "env1", 2));
        await enqueueItems(queue, "batch1", "env1", createBatchItems(2));

        await vi.waitFor(
          () => {
            expect(completionResult).not.toBeNull();
          },
          { timeout: 5000 }
        );

        // Exception should be recorded as failure
        expect(completionResult!.failedRunCount).toBe(1);
        expect(completionResult!.failures[0].error).toBe("Unexpected error");
        expect(completionResult!.failures[0].errorCode).toBe("UNEXPECTED_ERROR");
      } finally {
        await queue.close();
      }
    });
  });

  describe("consumer lifecycle", () => {
    redisTest("should start and stop consumers", async ({ redisContainer }) => {
      const queue = createBatchQueue(redisContainer, { startConsumers: false });

      try {
        // Start consumers
        queue.start();

        // Should be able to stop without error
        await queue.stop();

        // Should be able to start again
        queue.start();
      } finally {
        await queue.close();
      }
    });

    redisTest(
      "should process items only when consumers are started",
      async ({ redisContainer }) => {
        const queue = createBatchQueue(redisContainer, { startConsumers: false });
        const processedItems: number[] = [];
        let completionCalled = false;

        try {
          queue.onProcessItem(async ({ itemIndex }) => {
            processedItems.push(itemIndex);
            return { success: true, runId: `run_${itemIndex}` };
          });

          queue.onBatchComplete(async () => {
            completionCalled = true;
          });

          // Enqueue batch without starting consumers
          await queue.initializeBatch(createInitOptions("batch1", "env1", 3));
          await enqueueItems(queue, "batch1", "env1", createBatchItems(3));

          // Wait a bit - nothing should be processed
          await new Promise((resolve) => setTimeout(resolve, 200));
          expect(processedItems).toHaveLength(0);

          // Now start consumers
          queue.start();

          // Wait for processing
          await vi.waitFor(
            () => {
              expect(completionCalled).toBe(true);
            },
            { timeout: 5000 }
          );

          expect(processedItems).toHaveLength(3);
        } finally {
          await queue.close();
        }
      }
    );
  });

  describe("fair scheduling (DRR)", () => {
    redisTest(
      "should process batches from multiple environments fairly",
      async ({ redisContainer }) => {
        const queue = createBatchQueue(redisContainer, { startConsumers: true });
        const processedByEnv: Record<string, number[]> = { env1: [], env2: [] };
        const completedBatches: string[] = [];

        try {
          queue.onProcessItem(async ({ itemIndex, meta }) => {
            processedByEnv[meta.environmentId].push(itemIndex);
            return { success: true, runId: `run_${meta.environmentId}_${itemIndex}` };
          });

          queue.onBatchComplete(async (result) => {
            completedBatches.push(result.batchId);
          });

          // Initialize and enqueue batches for two environments
          await queue.initializeBatch(createInitOptions("batch1", "env1", 20));
          await queue.initializeBatch(createInitOptions("batch2", "env2", 20));
          await enqueueItems(queue, "batch1", "env1", createBatchItems(20));
          await enqueueItems(queue, "batch2", "env2", createBatchItems(20));

          // Wait for both to complete
          await vi.waitFor(
            () => {
              expect(completedBatches).toHaveLength(2);
            },
            { timeout: 10000 }
          );

          // Both environments should have been processed
          expect(processedByEnv.env1).toHaveLength(20);
          expect(processedByEnv.env2).toHaveLength(20);
        } finally {
          await queue.close();
        }
      }
    );

    redisTest("should not let one environment monopolize", async ({ redisContainer }) => {
      const queue = createBatchQueue(redisContainer, { startConsumers: true });
      const processOrder: string[] = [];

      try {
        queue.onProcessItem(async ({ meta }) => {
          processOrder.push(meta.environmentId);
          // Small delay to simulate work
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { success: true, runId: `run_${Date.now()}` };
        });

        // Initialize and enqueue env1 with many items first
        await queue.initializeBatch(createInitOptions("batch1", "env1", 30));
        await enqueueItems(queue, "batch1", "env1", createBatchItems(30));

        // Small delay then enqueue env2
        await new Promise((resolve) => setTimeout(resolve, 50));
        await queue.initializeBatch(createInitOptions("batch2", "env2", 10));
        await enqueueItems(queue, "batch2", "env2", createBatchItems(10));

        // Wait for env2 batch to complete
        await vi.waitFor(
          () => {
            const env2Count = processOrder.filter((e) => e === "env2").length;
            expect(env2Count).toBe(10);
          },
          { timeout: 10000 }
        );

        // Check that env2 items were interleaved, not all at the end
        // Find first env2 item position
        const firstEnv2Index = processOrder.indexOf("env2");
        // Env2 should appear before all env1 items are processed
        expect(firstEnv2Index).toBeLessThan(30);
      } finally {
        await queue.close();
      }
    });
  });

  describe("batch results", () => {
    redisTest("should track successful runs in completion result", async ({ redisContainer }) => {
      const queue = createBatchQueue(redisContainer, { startConsumers: true });
      let completionResult: CompleteBatchResult | null = null;

      try {
        queue.onProcessItem(async ({ itemIndex }) => {
          return { success: true, runId: `run_${itemIndex}` };
        });

        queue.onBatchComplete(async (result) => {
          completionResult = result;
        });

        await queue.initializeBatch(createInitOptions("batch1", "env1", 5));
        await enqueueItems(queue, "batch1", "env1", createBatchItems(5));

        await vi.waitFor(
          () => {
            expect(completionResult).not.toBeNull();
          },
          { timeout: 5000 }
        );

        // Verify completion result contains all runs
        // Note: After completion, batch data is cleaned up from Redis
        expect(completionResult!.batchId).toBe("batch1");
        expect(completionResult!.successfulRunCount).toBe(5);
        expect(completionResult!.failedRunCount).toBe(0);
        expect(completionResult!.runIds).toHaveLength(5);
        expect(completionResult!.runIds).toContain("run_0");
        expect(completionResult!.runIds).toContain("run_4");
      } finally {
        await queue.close();
      }
    });

    redisTest(
      "should track failures with details in completion result",
      async ({ redisContainer }) => {
        const queue = createBatchQueue(redisContainer, { startConsumers: true });
        let completionResult: CompleteBatchResult | null = null;

        try {
          queue.onProcessItem(async ({ itemIndex, item }) => {
            if (itemIndex % 2 === 0) {
              return {
                success: false,
                error: `Error on ${item.task}`,
                errorCode: "VALIDATION_ERROR",
              };
            }
            return { success: true, runId: `run_${itemIndex}` };
          });

          queue.onBatchComplete(async (result) => {
            completionResult = result;
          });

          await queue.initializeBatch(createInitOptions("batch1", "env1", 4));
          await enqueueItems(queue, "batch1", "env1", createBatchItems(4));

          await vi.waitFor(
            () => {
              expect(completionResult).not.toBeNull();
            },
            { timeout: 5000 }
          );

          // Verify completion result has failure details
          // Note: After completion, batch data is cleaned up from Redis
          expect(completionResult!.batchId).toBe("batch1");
          expect(completionResult!.successfulRunCount).toBe(2); // Items 1 and 3 succeeded
          expect(completionResult!.failedRunCount).toBe(2); // Items 0 and 2 failed
          expect(completionResult!.failures).toHaveLength(2);

          for (const failure of completionResult!.failures) {
            expect(failure.errorCode).toBe("VALIDATION_ERROR");
            expect(failure.taskIdentifier).toMatch(/^task-\d+$/);
            expect(failure.error).toMatch(/^Error on task-\d+$/);
            expect([0, 2]).toContain(failure.index); // Even indices failed
          }
        } finally {
          await queue.close();
        }
      }
    );

    redisTest("should preserve order of successful runs", async ({ redisContainer }) => {
      const queue = createBatchQueue(redisContainer, { startConsumers: true });
      let completionResult: CompleteBatchResult | null = null;

      try {
        queue.onProcessItem(async ({ itemIndex }) => {
          return { success: true, runId: `run_${itemIndex}` };
        });

        queue.onBatchComplete(async (result) => {
          completionResult = result;
        });

        await queue.initializeBatch(createInitOptions("batch1", "env1", 10));
        await enqueueItems(queue, "batch1", "env1", createBatchItems(10));

        await vi.waitFor(
          () => {
            expect(completionResult).not.toBeNull();
          },
          { timeout: 5000 }
        );

        // Runs should be in order since items are processed sequentially
        expect(completionResult!.runIds).toEqual([
          "run_0",
          "run_1",
          "run_2",
          "run_3",
          "run_4",
          "run_5",
          "run_6",
          "run_7",
          "run_8",
          "run_9",
        ]);
      } finally {
        await queue.close();
      }
    });
  });
});
