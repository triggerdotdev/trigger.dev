import { batch, logger, runs, task, tasks } from "@trigger.dev/sdk/v3";
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
