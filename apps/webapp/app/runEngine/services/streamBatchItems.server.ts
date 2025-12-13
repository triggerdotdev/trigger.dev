import {
  type BatchItemNDJSON,
  type StreamBatchItemsResponse,
  BatchItemNDJSON as BatchItemNDJSONSchema,
} from "@trigger.dev/core/v3";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import type { BatchItem, RunEngine } from "@internal/run-engine";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { ServiceValidationError, WithRunEngine } from "../../v3/services/baseService.server";
import { BatchPayloadProcessor } from "../concerns/batchPayloads.server";

export type StreamBatchItemsServiceOptions = {
  maxItemBytes: number;
};

export type StreamBatchItemsServiceConstructorOptions = {
  prisma?: PrismaClientOrTransaction;
  engine?: RunEngine;
};

/**
 * Stream Batch Items Service (Phase 2 of 2-phase batch API).
 *
 * This service handles Phase 2 of the streaming batch API:
 * 1. Validates batch exists and is in PENDING status
 * 2. Processes NDJSON stream item by item
 * 3. Calls engine.enqueueBatchItem() for each item
 * 4. Tracks accepted/deduplicated counts
 * 5. On completion: validates count, seals the batch
 *
 * The service is designed for streaming and processes items as they arrive,
 * providing backpressure through the async iterator pattern.
 */
export class StreamBatchItemsService extends WithRunEngine {
  private readonly payloadProcessor: BatchPayloadProcessor;

  constructor(opts: StreamBatchItemsServiceConstructorOptions = {}) {
    super({ prisma: opts.prisma ?? prisma, engine: opts.engine });
    this.payloadProcessor = new BatchPayloadProcessor();
  }

  /**
   * Process a stream of batch items from an async iterator.
   * Each item is validated and enqueued to the BatchQueue.
   * The batch is sealed when the stream completes.
   */
  public async call(
    environment: AuthenticatedEnvironment,
    batchFriendlyId: string,
    itemsIterator: AsyncIterable<unknown>,
    options: StreamBatchItemsServiceOptions
  ): Promise<StreamBatchItemsResponse> {
    return this.traceWithEnv<StreamBatchItemsResponse>(
      "streamBatchItems()",
      environment,
      async (span) => {
        span.setAttribute("batchId", batchFriendlyId);

        // Convert friendly ID to internal ID
        const batchId = BatchId.fromFriendlyId(batchFriendlyId);

        // Validate batch exists and belongs to this environment
        const batch = await this._prisma.batchTaskRun.findFirst({
          where: {
            id: batchId,
            runtimeEnvironmentId: environment.id,
          },
          select: {
            id: true,
            friendlyId: true,
            status: true,
            runCount: true,
            sealed: true,
            batchVersion: true,
          },
        });

        if (!batch) {
          throw new ServiceValidationError(`Batch ${batchFriendlyId} not found`);
        }

        if (batch.sealed) {
          throw new ServiceValidationError(
            `Batch ${batchFriendlyId} is already sealed and cannot accept more items`
          );
        }

        if (batch.status !== "PENDING") {
          throw new ServiceValidationError(
            `Batch ${batchFriendlyId} is not in PENDING status (current: ${batch.status})`
          );
        }

        let itemsAccepted = 0;
        let itemsDeduplicated = 0;
        let lastIndex = -1;

        // Process items from the stream
        for await (const rawItem of itemsIterator) {
          // Parse and validate the item
          const parseResult = BatchItemNDJSONSchema.safeParse(rawItem);
          if (!parseResult.success) {
            throw new ServiceValidationError(
              `Invalid item at index ${lastIndex + 1}: ${parseResult.error.message}`
            );
          }

          const item = parseResult.data;
          lastIndex = item.index;

          // Validate index is within expected range
          if (item.index >= batch.runCount) {
            throw new ServiceValidationError(
              `Item index ${item.index} exceeds batch runCount ${batch.runCount}`
            );
          }

          // Get the original payload type
          const originalPayloadType = (item.options?.payloadType as string) ?? "application/json";

          // Process payload - offload to R2 if it exceeds threshold
          const processedPayload = await this.payloadProcessor.process(
            item.payload,
            originalPayloadType,
            batchId,
            item.index,
            environment
          );

          // Convert to BatchItem format with potentially offloaded payload
          const batchItem: BatchItem = {
            task: item.task,
            payload: processedPayload.payload,
            payloadType: processedPayload.payloadType,
            options: item.options,
          };

          // Enqueue the item
          const result = await this._engine.enqueueBatchItem(
            batchId,
            environment.id,
            item.index,
            batchItem
          );

          if (result.enqueued) {
            itemsAccepted++;
          } else {
            itemsDeduplicated++;
          }
        }

        // Get the actual enqueued count from Redis
        const enqueuedCount = await this._engine.getBatchEnqueuedCount(batchId);

        // Validate we received the expected number of items
        if (enqueuedCount !== batch.runCount) {
          logger.warn("Batch item count mismatch", {
            batchId: batchFriendlyId,
            expected: batch.runCount,
            received: enqueuedCount,
            itemsAccepted,
            itemsDeduplicated,
          });

          // Don't seal the batch if count doesn't match
          // Return sealed: false so client knows to retry with missing items
          return {
            id: batchFriendlyId,
            itemsAccepted,
            itemsDeduplicated,
            sealed: false,
            enqueuedCount,
            expectedCount: batch.runCount,
          };
        }

        // Seal the batch - use conditional update to prevent TOCTOU race
        // Another concurrent request may have already sealed this batch
        const now = new Date();
        const sealResult = await this._prisma.batchTaskRun.updateMany({
          where: {
            id: batchId,
            sealed: false,
            status: "PENDING",
          },
          data: {
            sealed: true,
            sealedAt: now,
            status: "PROCESSING",
            processingStartedAt: now,
          },
        });

        // Check if we won the race to seal the batch
        if (sealResult.count === 0) {
          // Another request sealed the batch first - re-query to check current state
          const currentBatch = await this._prisma.batchTaskRun.findUnique({
            where: { id: batchId },
            select: {
              id: true,
              friendlyId: true,
              status: true,
              sealed: true,
            },
          });

          if (currentBatch?.sealed && currentBatch.status === "PROCESSING") {
            // The batch was sealed by another request - this is fine, the goal was achieved
            logger.info("Batch already sealed by concurrent request", {
              batchId: batchFriendlyId,
              itemsAccepted,
              itemsDeduplicated,
              envId: environment.id,
            });

            span.setAttribute("itemsAccepted", itemsAccepted);
            span.setAttribute("itemsDeduplicated", itemsDeduplicated);
            span.setAttribute("sealedByConcurrentRequest", true);

            return {
              id: batchFriendlyId,
              itemsAccepted,
              itemsDeduplicated,
              sealed: true,
            };
          }

          // Batch is in an unexpected state - fail with error
          const actualStatus = currentBatch?.status ?? "unknown";
          const actualSealed = currentBatch?.sealed ?? "unknown";
          logger.error("Batch seal race condition: unexpected state", {
            batchId: batchFriendlyId,
            expectedStatus: "PENDING",
            actualStatus,
            expectedSealed: false,
            actualSealed,
            envId: environment.id,
          });

          throw new ServiceValidationError(
            `Batch ${batchFriendlyId} is in unexpected state (status: ${actualStatus}, sealed: ${actualSealed}). Cannot seal batch.`
          );
        }

        logger.info("Batch sealed and ready for processing", {
          batchId: batchFriendlyId,
          itemsAccepted,
          itemsDeduplicated,
          totalEnqueued: enqueuedCount,
          envId: environment.id,
        });

        span.setAttribute("itemsAccepted", itemsAccepted);
        span.setAttribute("itemsDeduplicated", itemsDeduplicated);

        return {
          id: batchFriendlyId,
          itemsAccepted,
          itemsDeduplicated,
          sealed: true,
        };
      }
    );
  }
}

/**
 * Create an NDJSON parser transform stream.
 *
 * Converts a stream of Uint8Array chunks into parsed JSON objects.
 * Each line in the NDJSON is parsed independently.
 *
 * @param maxItemBytes - Maximum allowed bytes per line (item)
 * @returns TransformStream that outputs parsed JSON objects
 */
export function createNdjsonParserStream(
  maxItemBytes: number
): TransformStream<Uint8Array, unknown> {
  const decoder = new TextDecoder();
  let buffer = "";
  let lineNumber = 0;

  return new TransformStream<Uint8Array, unknown>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // Split on newlines
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        lineNumber++;
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Check byte size before parsing
        const lineBytes = new TextEncoder().encode(trimmed).length;
        if (lineBytes > maxItemBytes) {
          throw new Error(
            `Item at line ${lineNumber} exceeds maximum size of ${maxItemBytes} bytes (actual: ${lineBytes})`
          );
        }

        try {
          const obj = JSON.parse(trimmed);
          controller.enqueue(obj);
        } catch (err) {
          throw new Error(`Invalid JSON at line ${lineNumber}: ${(err as Error).message}`);
        }
      }
    },
    flush(controller) {
      // Handle any remaining buffered data (no trailing newline case)
      const final = buffer.trim();
      if (!final) return;

      lineNumber++;
      const lineBytes = new TextEncoder().encode(final).length;
      if (lineBytes > maxItemBytes) {
        throw new Error(
          `Item at line ${lineNumber} exceeds maximum size of ${maxItemBytes} bytes (actual: ${lineBytes})`
        );
      }

      try {
        const obj = JSON.parse(final);
        controller.enqueue(obj);
      } catch (err) {
        throw new Error(`Invalid JSON at line ${lineNumber}: ${(err as Error).message}`);
      }
    },
  });
}

/**
 * Convert a ReadableStream into an AsyncIterable.
 * Useful for processing streams with for-await-of loops.
 */
export async function* streamToAsyncIterable<T>(stream: ReadableStream<T>): AsyncIterable<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
