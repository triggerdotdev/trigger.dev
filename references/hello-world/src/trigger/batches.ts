import { batch, BatchTriggerError, logger, runs, task, tasks } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";

// ============================================================================
// Toxiproxy-based Retry Testing
// ============================================================================
// These tests use Toxiproxy to inject real network failures and verify
// that the SDK's batch streaming retry logic works correctly.
//
// Prerequisites:
// 1. Run `pnpm run docker` to start services including toxiproxy
// 2. Toxiproxy proxies localhost:3030 (webapp) on localhost:30303
// 3. Toxiproxy API is available on localhost:8474
// ============================================================================

const TOXIPROXY_API = "http://localhost:8474";
const TOXIPROXY_PROXY_NAME = "trigger_webapp_local";
const PROXIED_API_URL = "http://localhost:30303"; // Goes through toxiproxy

/**
 * Toxiproxy API helper - adds a toxic to inject failures
 */
async function addToxic(toxic: {
  name: string;
  type: string;
  stream?: "upstream" | "downstream";
  toxicity?: number;
  attributes?: Record<string, unknown>;
}): Promise<void> {
  const response = await fetch(`${TOXIPROXY_API}/proxies/${TOXIPROXY_PROXY_NAME}/toxics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      stream: "downstream", // Server -> Client
      toxicity: 1.0, // 100% of connections affected
      ...toxic,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to add toxic: ${response.status} ${text}`);
  }

  logger.info(`Added toxic: ${toxic.name}`, { toxic });
}

/**
 * Toxiproxy API helper - removes a toxic
 */
async function removeToxic(name: string): Promise<void> {
  const response = await fetch(`${TOXIPROXY_API}/proxies/${TOXIPROXY_PROXY_NAME}/toxics/${name}`, {
    method: "DELETE",
  });

  if (!response.ok && response.status !== 404) {
    const text = await response.text();
    throw new Error(`Failed to remove toxic: ${response.status} ${text}`);
  }

  logger.info(`Removed toxic: ${name}`);
}

/**
 * Toxiproxy API helper - list all toxics
 */
async function listToxics(): Promise<unknown[]> {
  const response = await fetch(`${TOXIPROXY_API}/proxies/${TOXIPROXY_PROXY_NAME}/toxics`);
  if (!response.ok) {
    return [];
  }
  return response.json();
}

/**
 * Toxiproxy API helper - clear all toxics
 */
async function clearAllToxics(): Promise<void> {
  const toxics = (await listToxics()) as Array<{ name: string }>;
  for (const toxic of toxics) {
    await removeToxic(toxic.name);
  }
  logger.info("Cleared all toxics");
}

/**
 * Test: Batch retry with connection reset injection
 *
 * This test:
 * 1. Configures SDK to use the proxied URL (through toxiproxy)
 * 2. Adds a "reset_peer" toxic that will kill connections
 * 3. Triggers a batch - the connection will be reset mid-stream
 * 4. SDK should retry with tee'd stream
 * 5. Removes toxic so retry succeeds
 * 6. Verifies all items were processed exactly once
 *
 * Run with: `npx trigger.dev@latest dev` then trigger this task
 */
export const batchRetryWithToxiproxy = task({
  id: "batch-retry-with-toxiproxy",
  machine: "small-1x",
  maxDuration: 300,
  run: async (payload: { count: number; failAfterBytes?: number }) => {
    const count = payload.count || 50;
    const failAfterBytes = payload.failAfterBytes || 5000; // Fail after ~5KB sent

    // Clear any existing toxics
    await clearAllToxics();

    // Generate batch items
    const items = Array.from({ length: count }, (_, i) => ({
      payload: { index: i, batchTest: "toxiproxy-retry" },
    }));

    // Add a toxic that limits data then resets connection
    // This simulates a connection failure mid-stream
    await addToxic({
      name: "limit_and_reset",
      type: "limit_data",
      stream: "upstream", // Client -> Server (our stream upload)
      attributes: {
        bytes: failAfterBytes, // Allow this many bytes then close
      },
    });

    logger.info("Starting batch trigger through toxiproxy", {
      count,
      failAfterBytes,
      apiUrl: PROXIED_API_URL,
    });

    // Schedule toxic removal after a delay to allow retry to succeed
    const toxicRemovalPromise = (async () => {
      await setTimeout(2000); // Wait for first attempt to fail
      await clearAllToxics();
      logger.info("Toxic removed - retry should succeed now");
    })();

    try {
      // Trigger batch through the proxied URL
      // The first attempt will fail due to the toxic, retry should succeed
      const result = await tasks.batchTrigger<typeof retryTrackingTask>(
        "retry-tracking-task",
        items,
        undefined,
        {
          // Use the proxied URL that goes through toxiproxy
          clientConfig: {
            baseURL: PROXIED_API_URL,
          },
        }
      );

      // Wait for toxic removal to complete
      await toxicRemovalPromise;

      logger.info("Batch triggered successfully!", {
        batchId: result.batchId,
        runCount: result.runCount,
      });

      // Wait for runs to complete
      await setTimeout(10000);

      // Retrieve batch to check results
      const batchResult = await batch.retrieve(result.batchId);

      return {
        success: true,
        batchId: result.batchId,
        runCount: result.runCount,
        batchStatus: batchResult.status,
        note: "Check logs to see retry behavior. Items should be deduplicated on server.",
      };
    } catch (error) {
      // Clean up toxics on error
      await clearAllToxics();

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        note: "Batch failed - check if toxiproxy is running and webapp is accessible",
      };
    }
  },
});

/**
 * Test: Verify deduplication after retry
 *
 * This test uses a slower toxic (latency + timeout) and verifies
 * that items processed before failure aren't reprocessed after retry.
 */
export const batchDeduplicationTest = task({
  id: "batch-deduplication-test",
  machine: "small-1x",
  maxDuration: 300,
  run: async (payload: { count: number }) => {
    const count = payload.count || 20;

    // Clear any existing toxics
    await clearAllToxics();

    // Create a unique test ID to track this specific batch
    const testId = `dedup-${Date.now()}`;

    // Items with tags for easy querying
    const items = Array.from({ length: count }, (_, i) => ({
      payload: {
        index: i,
        testId,
      },
      options: {
        tags: [`testId:${testId}`, `index:${i}`],
      },
    }));

    // Add timeout toxic - connection will timeout mid-stream
    await addToxic({
      name: "timeout_test",
      type: "timeout",
      stream: "upstream",
      attributes: {
        timeout: 1000, // Timeout after 1 second
      },
    });

    // Remove toxic after delay so retry succeeds
    setTimeout(3000).then(() => clearAllToxics());

    try {
      const result = await tasks.batchTrigger<typeof retryTrackingTask>(
        "retry-tracking-task",
        items,
        undefined,
        { clientConfig: { baseURL: PROXIED_API_URL } }
      );

      // Wait for completion
      await setTimeout(15000);

      // Query all runs with our testId to check for duplicates
      const allRuns = await runs.list({
        tag: `testId:${testId}`,
      });

      // Collect run IDs first (list doesn't include payload)
      const runIds: string[] = [];
      for await (const run of allRuns) {
        runIds.push(run.id);
      }

      // Retrieve full run details to get payloads
      const runDetails = await Promise.all(runIds.map((id) => runs.retrieve(id)));

      // Count occurrences of each index
      const indexCounts = new Map<number, number>();
      for (const run of runDetails) {
        const payload = run.payload as { index: number } | undefined;
        if (payload?.index !== undefined) {
          indexCounts.set(payload.index, (indexCounts.get(payload.index) || 0) + 1);
        }
      }

      const duplicates = Array.from(indexCounts.entries()).filter(([_, count]) => count > 1);

      return {
        batchId: result.batchId,
        totalRuns: runIds.length,
        expectedRuns: count,
        duplicates: duplicates.length > 0 ? duplicates : "none",
        success: duplicates.length === 0 && runIds.length === count,
      };
    } finally {
      await clearAllToxics();
    }
  },
});

/**
 * Task that tracks its execution for deduplication verification.
 * Tags are set when triggering via batch options.
 */
export const retryTrackingTask = task({
  id: "retry-tracking-task",
  retry: { maxAttempts: 1 }, // Don't retry the task itself
  run: async (payload: { index: number; testId?: string; batchTest?: string }) => {
    logger.info(`Processing item ${payload.index}`, { payload });

    await setTimeout(100);

    return {
      index: payload.index,
      processedAt: Date.now(),
    };
  },
});

/**
 * Simple test to verify toxiproxy is working
 */
export const toxiproxyHealthCheck = task({
  id: "toxiproxy-health-check",
  run: async () => {
    // Check toxiproxy API
    const apiResponse = await fetch(`${TOXIPROXY_API}/proxies`);
    const proxies = await apiResponse.json();

    // Check proxied webapp
    let webappStatus = "unknown";
    try {
      const webappResponse = await fetch(`${PROXIED_API_URL}/api/v1/whoami`, {
        headers: {
          Authorization: `Bearer ${process.env.TRIGGER_SECRET_KEY}`,
        },
      });
      webappStatus = webappResponse.ok ? "ok" : `error: ${webappResponse.status}`;
    } catch (e) {
      webappStatus = `error: ${e instanceof Error ? e.message : String(e)}`;
    }

    // List current toxics
    const toxics = await listToxics();

    return {
      toxiproxyApi: apiResponse.ok ? "ok" : "error",
      proxies,
      webappThroughProxy: webappStatus,
      currentToxics: toxics,
    };
  },
});

export const batchTriggerAndWait = task({
  id: "batch-trigger-and-wait",
  maxDuration: 60,
  run: async (payload: { count: number }, { ctx }) => {
    const payloads = Array.from({ length: payload.count }, (_, i) => ({
      payload: { waitSeconds: 1, output: `test${i}` },
    }));

    // First batch triggerAndWait with idempotency keys
    const firstResults = await fixedLengthTask.batchTriggerAndWait(payloads);
  },
});

// ============================================================================
// Rate Limit Error Testing
// ============================================================================

/**
 * Test: Intentionally trigger a rate limit error to verify BatchTriggerError improvements
 *
 * This test triggers many batches in rapid succession to exceed the rate limit.
 * When a rate limit is hit, it verifies that:
 * 1. The error is a BatchTriggerError
 * 2. The error has isRateLimited = true
 * 3. The error message includes rate limit details
 * 4. The retryAfterMs property is set
 *
 * Run this from backend code, not from inside a task (to avoid worker rate limits).
 */
export const rateLimitErrorTest = task({
  id: "rate-limit-error-test",
  maxDuration: 300,
  run: async (payload: { batchesPerAttempt?: number; itemsPerBatch?: number }) => {
    const batchesPerAttempt = payload.batchesPerAttempt || 50;
    const itemsPerBatch = payload.itemsPerBatch || 100;

    logger.info("Starting rate limit error test", {
      batchesPerAttempt,
      itemsPerBatch,
      totalItems: batchesPerAttempt * itemsPerBatch,
    });

    const results: Array<{
      batchIndex: number;
      success: boolean;
      batchId?: string;
      error?: {
        message: string;
        name: string;
        isRateLimited?: boolean;
        retryAfterMs?: number;
        phase?: string;
      };
    }> = [];

    // Try to trigger many batches rapidly
    const batchPromises = Array.from({ length: batchesPerAttempt }, async (_, batchIndex) => {
      const items = Array.from({ length: itemsPerBatch }, (_, i) => ({
        payload: { index: batchIndex * itemsPerBatch + i, testId: `rate-limit-test-${Date.now()}` },
      }));

      try {
        const result = await retryTrackingTask.batchTrigger(items);
        return {
          batchIndex,
          success: true as const,
          batchId: result.batchId,
        };
      } catch (error) {
        // Log the error details for inspection
        if (error instanceof BatchTriggerError) {
          logger.info(`BatchTriggerError caught for batch ${batchIndex}`, {
            message: error.message,
            name: error.name,
            isRateLimited: error.isRateLimited,
            retryAfterMs: error.retryAfterMs,
            phase: error.phase,
            batchId: error.batchId,
            itemCount: error.itemCount,
            cause: error.cause instanceof Error ? error.cause.message : String(error.cause),
          });

          return {
            batchIndex,
            success: false as const,
            error: {
              message: error.message,
              name: error.name,
              isRateLimited: error.isRateLimited,
              retryAfterMs: error.retryAfterMs,
              phase: error.phase,
            },
          };
        }

        // Non-BatchTriggerError
        const err = error instanceof Error ? error : new Error(String(error));
        logger.warn(`Non-BatchTriggerError caught for batch ${batchIndex}`, {
          message: err.message,
          name: err.name,
        });

        return {
          batchIndex,
          success: false as const,
          error: {
            message: err.message,
            name: err.name,
          },
        };
      }
    });

    // Wait for all attempts (use allSettled to capture all results)
    const settled = await Promise.allSettled(batchPromises);

    for (const result of settled) {
      if (result.status === "fulfilled") {
        results.push(result.value);
      } else {
        results.push({
          batchIndex: -1,
          success: false,
          error: {
            message: result.reason?.message || String(result.reason),
            name: result.reason?.name || "Error",
          },
        });
      }
    }

    // Analyze results
    const successCount = results.filter((r) => r.success).length;
    const rateLimitedCount = results.filter((r) => !r.success && r.error?.isRateLimited).length;
    const otherErrorCount = results.filter((r) => !r.success && !r.error?.isRateLimited).length;

    // Get a sample rate limit error for inspection
    const sampleRateLimitError = results.find((r) => r.error?.isRateLimited)?.error;

    return {
      summary: {
        totalBatches: batchesPerAttempt,
        successCount,
        rateLimitedCount,
        otherErrorCount,
      },
      sampleRateLimitError: sampleRateLimitError || null,
      allResults: results,
      testPassed:
        rateLimitedCount > 0 &&
        sampleRateLimitError?.isRateLimited === true &&
        typeof sampleRateLimitError?.retryAfterMs === "number",
    };
  },
});

/**
 * Simpler test: Direct batch trigger that's likely to hit rate limits
 *
 * This test just tries to batch trigger a very large number of items in one call.
 * If the organization has rate limits configured, this should trigger them.
 */
export const simpleBatchRateLimitTest = task({
  id: "simple-batch-rate-limit-test",
  maxDuration: 120,
  run: async (payload: { itemCount?: number }) => {
    const itemCount = payload.itemCount || 5000; // Large batch that might hit limits

    logger.info("Starting simple batch rate limit test", { itemCount });

    const items = Array.from({ length: itemCount }, (_, i) => ({
      payload: { index: i, testId: `simple-rate-test-${Date.now()}` },
    }));

    try {
      const result = await retryTrackingTask.batchTrigger(items);

      logger.info("Batch succeeded (no rate limit hit)", {
        batchId: result.batchId,
        runCount: result.runCount,
      });

      return {
        success: true,
        batchId: result.batchId,
        runCount: result.runCount,
        rateLimitHit: false,
      };
    } catch (error) {
      if (error instanceof BatchTriggerError) {
        logger.info("BatchTriggerError caught", {
          fullMessage: error.message,
          isRateLimited: error.isRateLimited,
          retryAfterMs: error.retryAfterMs,
          phase: error.phase,
          itemCount: error.itemCount,
          apiErrorType: error.apiError?.constructor.name,
        });

        return {
          success: false,
          rateLimitHit: error.isRateLimited,
          errorMessage: error.message,
          errorDetails: {
            phase: error.phase,
            itemCount: error.itemCount,
            isRateLimited: error.isRateLimited,
            retryAfterMs: error.retryAfterMs,
            hasApiError: !!error.apiError,
          },
        };
      }

      throw error; // Re-throw unexpected errors
    }
  },
});

// ============================================================================
// Streaming Batch Examples
// ============================================================================

/**
 * Example: Streaming batch trigger using an async generator
 *
 * This allows you to stream items to the batch without loading all items into memory.
 * Useful for large batches or when items are generated dynamically.
 */
export const streamingBatchTrigger = task({
  id: "streaming-batch-trigger",
  maxDuration: 120,
  run: async (payload: { count: number }) => {
    // Define an async generator that yields batch items
    async function* generateItems() {
      for (let i = 0; i < payload.count; i++) {
        yield {
          payload: { waitSeconds: 1, output: `streamed-${i}` },
        };
      }
    }

    // Trigger the batch using the generator - items are streamed to the server
    const result = await fixedLengthTask.batchTrigger(generateItems());

    return {
      batchId: result.batchId,
      runCount: result.runCount,
    };
  },
});

/**
 * Example: Streaming batch triggerAndWait using an async generator
 *
 * Similar to streaming trigger, but waits for all runs to complete.
 */
export const streamingBatchTriggerAndWait = task({
  id: "streaming-batch-trigger-and-wait",
  maxDuration: 300,
  run: async (payload: { count: number }) => {
    // Async generator for items
    async function* generateItems() {
      for (let i = 0; i < payload.count; i++) {
        yield {
          payload: { waitSeconds: 1, output: `streamed-wait-${i}` },
        };
      }
    }

    // Trigger and wait - items are streamed, then we wait for all results
    const results = await fixedLengthTask.batchTriggerAndWait(generateItems());

    // Process results
    const outputs = results.runs.filter((r) => r.ok).map((r) => (r.ok ? r.output : null));

    return { outputs };
  },
});

/**
 * Example: Streaming batch.trigger for multiple task types
 *
 * Use batch.trigger with a stream when triggering different task types.
 */
export const streamingMultiTaskBatch = task({
  id: "streaming-multi-task-batch",
  maxDuration: 120,
  run: async (payload: { count: number }) => {
    // Generator that yields items for different tasks
    async function* generateMultiTaskItems() {
      for (let i = 0; i < payload.count; i++) {
        // Alternate between task types
        if (i % 2 === 0) {
          yield {
            id: "fixed-length-lask" as const,
            payload: { waitSeconds: 1, output: `task1-${i}` },
          };
        } else {
          yield {
            id: "simple-task" as const,
            payload: { message: `task2-${i}` },
          };
        }
      }
    }

    // Use batch.trigger with the stream
    const result = await batch.trigger<typeof fixedLengthTask | typeof simpleTask>(
      generateMultiTaskItems()
    );

    return {
      batchId: result.batchId,
      runCount: result.runCount,
    };
  },
});

/**
 * Example: Using a ReadableStream for batch items
 *
 * You can also pass a ReadableStream instead of an AsyncIterable.
 */
export const readableStreamBatch = task({
  id: "readable-stream-batch",
  maxDuration: 120,
  run: async (payload: { count: number }) => {
    // Create a ReadableStream of batch items
    const stream = new ReadableStream<{ payload: Payload }>({
      async start(controller) {
        for (let i = 0; i < payload.count; i++) {
          controller.enqueue({
            payload: { waitSeconds: 1, output: `stream-${i}` },
          });
        }
        controller.close();
      },
    });

    // Trigger with the ReadableStream
    const result = await fixedLengthTask.batchTrigger(stream);

    return {
      batchId: result.batchId,
      runCount: result.runCount,
    };
  },
});

// Simple task for multi-task batch example
export const simpleTask = task({
  id: "simple-task",
  run: async (payload: { message: string }) => {
    await setTimeout(500);
    return { received: payload.message };
  },
});

// ============================================================================
// Queue Option Tests
// ============================================================================

/**
 * Task that runs in a specific queue for testing queue option handling.
 */
export const queuedTask = task({
  id: "queued-task",
  queue: {
    name: "test-queue-for-batch",
  },
  run: async (payload: { index: number; testId: string }) => {
    logger.info(`Processing queued task ${payload.index}`, { payload });
    await setTimeout(100);
    return {
      index: payload.index,
      testId: payload.testId,
      processedAt: Date.now(),
    };
  },
});

/**
 * Test: Batch trigger with queue option as object
 *
 * This test verifies that the queue option works correctly when passed
 * through batch trigger. The SDK passes queue as { name: "queue-name" }
 * which should be handled correctly by the server.
 *
 * This tests the fix for the double-wrapping bug where queue objects
 * like { name: "queue-name", concurrencyLimit: 20 } could get wrapped
 * into { name: { name: "queue-name", concurrencyLimit: 20 } }.
 */
export const batchTriggerWithQueueOption = task({
  id: "batch-trigger-with-queue-option",
  maxDuration: 120,
  run: async (payload: { count: number; useObjectQueue?: boolean }) => {
    const count = payload.count || 5;
    const testId = `queue-test-${Date.now()}`;

    // If useObjectQueue is true, we bypass the SDK types to send queue as an object
    // This simulates what might happen if someone calls the API directly with wrong format
    const queueValue = payload.useObjectQueue
      ? ({ name: "test-queue-for-batch", concurrencyLimit: 20 } as unknown as string)
      : "test-queue-for-batch";

    // Generate batch items with queue option specified
    const items = Array.from({ length: count }, (_, i) => ({
      payload: { index: i, testId },
      options: {
        queue: queueValue,
        // Also test with lockToVersion since the error showed workers.some.id
        // which only appears in the lockedBackgroundWorker code path
      },
    }));

    logger.info("Starting batch trigger with queue option", {
      count,
      testId,
      useObjectQueue: payload.useObjectQueue,
      queueValue,
    });

    // Trigger the batch with queue option
    const result = await queuedTask.batchTrigger(items);

    logger.info("Batch triggered successfully", {
      batchId: result.batchId,
      runCount: result.runCount,
    });

    // Wait for runs to complete
    await setTimeout(5000);

    // Retrieve batch to check results
    const batchResult = await batch.retrieve(result.batchId);

    return {
      success: true,
      batchId: result.batchId,
      runCount: result.runCount,
      batchStatus: batchResult.status,
      testId,
    };
  },
});

/**
 * Test: Batch triggerAndWait with queue option
 *
 * Similar to above but waits for all runs to complete.
 */
export const batchTriggerAndWaitWithQueueOption = task({
  id: "batch-trigger-and-wait-with-queue-option",
  maxDuration: 120,
  run: async (payload: { count: number }) => {
    const count = payload.count || 5;
    const testId = `queue-wait-test-${Date.now()}`;

    // Generate items with queue option
    const items = Array.from({ length: count }, (_, i) => ({
      payload: { index: i, testId },
      options: {
        queue: "test-queue-for-batch",
      },
    }));

    logger.info("Starting batch triggerAndWait with queue option", { count, testId });

    // Trigger and wait
    const results = await queuedTask.batchTriggerAndWait(items);

    const successCount = results.runs.filter((r) => r.ok).length;
    const outputs = results.runs.filter((r) => r.ok).map((r) => (r.ok ? r.output : null));

    return {
      success: successCount === count,
      successCount,
      totalCount: count,
      outputs,
      testId,
    };
  },
});

/**
 * Test: Streaming batch trigger with queue option
 *
 * Tests that streaming batches also work correctly with queue options.
 */
export const streamingBatchWithQueueOption = task({
  id: "streaming-batch-with-queue-option",
  maxDuration: 120,
  run: async (payload: { count: number }) => {
    const count = payload.count || 10;
    const testId = `stream-queue-test-${Date.now()}`;

    // Async generator that yields items with queue option
    async function* generateItems() {
      for (let i = 0; i < count; i++) {
        yield {
          payload: { index: i, testId },
          options: {
            queue: "test-queue-for-batch",
          },
        };
      }
    }

    logger.info("Starting streaming batch with queue option", { count, testId });

    // Trigger using the generator
    const result = await queuedTask.batchTrigger(generateItems());

    logger.info("Streaming batch triggered", {
      batchId: result.batchId,
      runCount: result.runCount,
    });

    // Wait and check results
    await setTimeout(5000);
    const batchResult = await batch.retrieve(result.batchId);

    return {
      success: true,
      batchId: result.batchId,
      runCount: result.runCount,
      batchStatus: batchResult.status,
      testId,
    };
  },
});

// ============================================================================
// Large Payload Examples (R2 Offloading)
// ============================================================================

/**
 * Helper to generate a large string payload.
 * Default threshold for R2 offloading is 512KB (BATCH_PAYLOAD_OFFLOAD_THRESHOLD).
 *
 * @param sizeInKB - Size of the payload in kilobytes
 */
function generateLargePayload(sizeInKB: number): string {
  // Each character is 1 byte in ASCII, so we generate sizeInKB * 1024 characters
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const targetSize = sizeInKB * 1024;
  let result = "";

  while (result.length < targetSize) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  return result;
}

/**
 * Example: Batch trigger with large payloads that get offloaded to R2
 *
 * When a batch item's payload exceeds BATCH_PAYLOAD_OFFLOAD_THRESHOLD (default 512KB),
 * it's automatically uploaded to R2 object storage. Only a reference path is stored
 * in Redis, reducing memory usage and allowing larger payloads.
 *
 * The task receives the full payload - the offloading is transparent.
 */
export const largePayloadBatch = task({
  id: "large-payload-batch",
  maxDuration: 300,
  machine: "large-2x",
  run: async (payload: { count: number; payloadSizeKB: number }) => {
    // Default to 600KB to exceed the 512KB threshold
    const sizeKB = payload.payloadSizeKB || 600;

    async function* generateLargeItems() {
      for (let i = 0; i < payload.count; i++) {
        yield {
          payload: {
            index: i,
            // This large data will be offloaded to R2
            largeData: generateLargePayload(sizeKB),
          },
        };
      }
    }

    // Trigger the batch - large payloads are automatically offloaded to R2
    const result = await largePayloadTask.batchTrigger(generateLargeItems());

    await setTimeout(5000);

    const myBatch = await batch.retrieve(result.batchId);

    logger.info("batch", { myBatch });

    return {
      batchId: result.batchId,
      runCount: result.runCount,
      payloadSizeKB: sizeKB,
      note: `Each payload was ~${sizeKB}KB. Payloads over 512KB are offloaded to R2.`,
    };
  },
});

/**
 * Example: Batch triggerAndWait with large payloads
 *
 * Same as above but waits for results.
 */
export const largePayloadBatchAndWait = task({
  id: "large-payload-batch-and-wait",
  maxDuration: 600,
  run: async (payload: { count: number; payloadSizeKB: number }) => {
    const sizeKB = payload.payloadSizeKB || 600;

    async function* generateLargeItems() {
      for (let i = 0; i < payload.count; i++) {
        yield {
          payload: {
            index: i,
            largeData: generateLargePayload(sizeKB),
          },
        };
      }
    }

    // Trigger and wait - large payloads are offloaded, results are returned
    const results = await largePayloadTask.batchTriggerAndWait(generateLargeItems());

    const successCount = results.runs.filter((r) => r.ok).length;
    const outputs = results.runs.filter((r) => r.ok).map((r) => (r.ok ? r.output : null));

    return {
      successCount,
      outputs,
      payloadSizeKB: sizeKB,
    };
  },
});

type LargePayload = {
  index: number;
  largeData: string;
};

/**
 * Task that receives large payloads.
 * The payload is transparently downloaded from R2 if it was offloaded.
 */
export const largePayloadTask = task({
  id: "large-payload-task",
  retry: {
    maxAttempts: 2,
  },
  machine: "small-1x",
  run: async (payload: LargePayload) => {
    // The large payload is available here - R2 download is transparent
    const payloadSizeBytes = payload.largeData.length;
    const payloadSizeKB = Math.round(payloadSizeBytes / 1024);

    await setTimeout(500);

    return {
      index: payload.index,
      receivedSizeKB: payloadSizeKB,
      preview: payload.largeData.substring(0, 50) + "...",
    };
  },
});

// ============================================================================
// Oversized Payload Graceful Handling
// ============================================================================

/**
 * Test: Batch with oversized item should complete gracefully
 *
 * Sends 2 items: one normal, one oversized (~3.2MB).
 * The oversized item should result in a pre-failed run (ok: false)
 * while the normal item processes successfully (ok: true).
 */
export const batchSealFailureOversizedPayload = task({
  id: "batch-seal-failure-oversized",
  maxDuration: 60,
  retry: {
    maxAttempts: 1,
  },
  run: async () => {
    const results = await fixedLengthTask.batchTriggerAndWait([
      { payload: { waitSeconds: 1, output: "normal" } },
      { payload: { waitSeconds: 1, output: "x".repeat(3_200_000) } }, // ~3.2MB oversized
    ]);

    const normal = results.runs[0];
    const oversized = results.runs[1];

    logger.info("Batch results", {
      normalOk: normal?.ok,
      oversizedOk: oversized?.ok,
    });

    return {
      normalOk: normal?.ok === true,
      oversizedOk: oversized?.ok === false,
      oversizedError: !oversized?.ok ? oversized?.error : undefined,
    };
  },
});

type Payload = {
  waitSeconds: number;
  error?: string;
  output?: any;
};

export const fixedLengthTask = task({
  id: "fixed-length-lask",
  retry: {
    maxAttempts: 2,
    maxTimeoutInMs: 100,
  },
  machine: "micro",
  run: async ({ waitSeconds = 1, error, output }: Payload) => {
    await setTimeout(waitSeconds * 1000);

    if (error) {
      throw new Error(error);
    }

    return output;
  },
});

// ============================================================================
// Queue Size Limit Testing
// ============================================================================
// These tests verify that per-queue size limits are enforced correctly.
//
// To test:
// 1. Set a low queue limit on the organization:
//    UPDATE "Organization" SET "maximumDeployedQueueSize" = 5 WHERE slug = 'references-9dfd';
// 2. Run these tasks to verify queue limits are enforced
// 3. Reset the limit when done:
//    UPDATE "Organization" SET "maximumDeployedQueueSize" = NULL WHERE slug = 'references-9dfd';
// ============================================================================

/**
 * Simple task for queue limit testing.
 * Has a dedicated queue so we can test per-queue limits independently.
 */
export const queueLimitTestTask = task({
  id: "queue-limit-test-task",
  queue: {
    name: "queue-limit-test-queue",
    concurrencyLimit: 1
  },
  run: async (payload: { index: number; testId: string }) => {
    logger.info(`Processing queue limit test task ${payload.index}`, { payload });
    // Sleep for a bit so runs stay in queue
    await setTimeout(5000);
    return {
      index: payload.index,
      testId: payload.testId,
      processedAt: Date.now(),
    };
  },
});

/**
 * Test: Single trigger that should fail when queue is at limit
 *
 * Steps to test:
 * 1. Set maximumDeployedQueueSize = 5 on the organization
 * 2. Run this task with count = 10
 * 3. First 5 triggers should succeed
 * 4. Remaining triggers should fail with queue limit error
 */
export const testSingleTriggerQueueLimit = task({
  id: "test-single-trigger-queue-limit",
  maxDuration: 120,
  run: async (payload: { count: number }) => {
    const count = payload.count || 10;
    const testId = `single-trigger-limit-${Date.now()}`;

    logger.info("Starting single trigger queue limit test", { count, testId });

    const results: Array<{
      index: number;
      success: boolean;
      runId?: string;
      error?: string;
    }> = [];

    // Trigger tasks one by one
    for (let i = 0; i < count; i++) {
      try {
        const handle = await queueLimitTestTask.trigger({
          index: i,
          testId,
        });

        results.push({
          index: i,
          success: true,
          runId: handle.id,
        });

        logger.info(`Triggered task ${i} successfully`, { runId: handle.id });

        await setTimeout(1000)
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        results.push({
          index: i,
          success: false,
          error: errorMessage,
        });

        logger.warn(`Failed to trigger task ${i}`, { error: errorMessage });
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.filter((r) => !r.success).length;
    const queueLimitErrors = results.filter(
      (r) => !r.success && r.error?.includes("queue")
    ).length;

    return {
      testId,
      totalAttempts: count,
      successCount,
      failCount,
      queueLimitErrors,
      results,
    };
  },
});

/**
 * Test: Batch trigger that should fail when queue limit would be exceeded
 *
 * Steps to test:
 * 1. Set maximumDeployedQueueSize = 5 on the organization
 * 2. Run this task with count = 10
 * 3. The batch should be aborted because it would exceed the queue limit
 */
export const testBatchTriggerQueueLimit = task({
  id: "test-batch-trigger-queue-limit",
  maxDuration: 120,
  run: async (payload: { count: number }) => {
    const count = payload.count || 10;
    const testId = `batch-trigger-limit-${Date.now()}`;

    logger.info("Starting batch trigger queue limit test", { count, testId });

    const items = Array.from({ length: count }, (_, i) => ({
      payload: { index: i, testId },
    }));

    try {
      const result = await queueLimitTestTask.batchTrigger(items);

      logger.info("Batch triggered successfully (no limit hit)", {
        batchId: result.batchId,
        runCount: result.runCount,
      });

      // Wait a bit and check batch status
      await setTimeout(2000);
      const batchResult = await batch.retrieve(result.batchId);

      return {
        testId,
        success: true,
        batchId: result.batchId,
        runCount: result.runCount,
        batchStatus: batchResult.status,
        queueLimitHit: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isQueueLimitError = errorMessage.toLowerCase().includes("queue");

      logger.info("Batch trigger failed", {
        error: errorMessage,
        isQueueLimitError,
      });

      return {
        testId,
        success: false,
        error: errorMessage,
        queueLimitHit: isQueueLimitError,
      };
    }
  },
});

/**
 * Test: Batch triggerAndWait that should fail when queue limit would be exceeded
 *
 * Same as testBatchTriggerQueueLimit but uses batchTriggerAndWait.
 * This tests the blocking batch path where the parent run is blocked
 * until the batch completes.
 *
 * Steps to test:
 * 1. Set maximumDevQueueSize = 5 on the organization
 * 2. Run this task with count = 10
 * 3. The batch should be aborted because it would exceed the queue limit
 */
export const testBatchTriggerAndWaitQueueLimit = task({
  id: "test-batch-trigger-and-wait-queue-limit",
  maxDuration: 120,
  run: async (payload: { count: number }) => {
    const count = payload.count || 10;
    const testId = `batch-wait-limit-${Date.now()}`;

    logger.info("Starting batch triggerAndWait queue limit test", { count, testId });

    const items = Array.from({ length: count }, (_, i) => ({
      payload: { index: i, testId },
    }));

    try {
      const result = await queueLimitTestTask.batchTriggerAndWait(items);

      logger.info("Batch triggerAndWait completed (no limit hit)", {
        batchId: result.id,
        runsCount: result.runs.length,
      });

      const successCount = result.runs.filter((r) => r.ok).length;
      const failCount = result.runs.filter((r) => !r.ok).length;

      return {
        testId,
        success: true,
        batchId: result.id,
        runsCount: result.runs.length,
        successCount,
        failCount,
        queueLimitHit: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isQueueLimitError = errorMessage.toLowerCase().includes("queue");

      logger.info("Batch triggerAndWait failed", {
        error: errorMessage,
        isQueueLimitError,
      });

      return {
        testId,
        success: false,
        error: errorMessage,
        queueLimitHit: isQueueLimitError,
      };
    }
  },
});

/**
 * Test: Batch trigger to multiple queues with different limits
 *
 * This tests that per-queue validation works correctly when batch items
 * go to different queues. Some items may succeed while the queue that
 * exceeds its limit causes the batch to abort.
 */
export const testMultiQueueBatchLimit = task({
  id: "test-multi-queue-batch-limit",
  maxDuration: 120,
  run: async (payload: { countPerQueue: number }) => {
    const countPerQueue = payload.countPerQueue || 5;
    const testId = `multi-queue-limit-${Date.now()}`;

    logger.info("Starting multi-queue batch limit test", { countPerQueue, testId });

    // Create items that go to different queues
    // queueLimitTestTask goes to "queue-limit-test-queue"
    // simpleTask goes to its default queue "task/simple-task"
    const items = [];

    // Add items for the queue-limit-test-queue
    for (let i = 0; i < countPerQueue; i++) {
      items.push({
        id: "queue-limit-test-task" as const,
        payload: { index: i, testId },
      });
    }

    // Add items for a different queue (simple-task uses default queue)
    for (let i = 0; i < countPerQueue; i++) {
      items.push({
        id: "simple-task" as const,
        payload: { message: `multi-queue-${i}` },
      });
    }

    try {
      const result = await batch.trigger<typeof queueLimitTestTask | typeof simpleTask>(items);

      logger.info("Multi-queue batch triggered successfully", {
        batchId: result.batchId,
        runCount: result.runCount,
      });

      await setTimeout(2000);
      const batchResult = await batch.retrieve(result.batchId);

      return {
        testId,
        success: true,
        batchId: result.batchId,
        runCount: result.runCount,
        batchStatus: batchResult.status,
        queueLimitHit: false,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isQueueLimitError = errorMessage.toLowerCase().includes("queue");

      logger.info("Multi-queue batch trigger failed", {
        error: errorMessage,
        isQueueLimitError,
      });

      return {
        testId,
        success: false,
        error: errorMessage,
        queueLimitHit: isQueueLimitError,
      };
    }
  },
});

/**
 * Helper task to check current queue size
 */
export const checkQueueSize = task({
  id: "check-queue-size",
  run: async () => {
    // This task just reports - actual queue size check is done server-side
    return {
      note: "Check the webapp logs or database for queue size information",
      hint: "Run: SELECT * FROM \"TaskRun\" WHERE queue = 'queue-limit-test-queue' AND status IN ('PENDING', 'EXECUTING');",
    };
  },
});
