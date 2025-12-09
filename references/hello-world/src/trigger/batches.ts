import { batch, logger, task } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";

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
