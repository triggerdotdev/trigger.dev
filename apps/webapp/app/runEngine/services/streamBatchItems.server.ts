import {
  type BatchItemNDJSON,
  type StreamBatchItemsResponse,
  BatchItemNDJSON as BatchItemNDJSONSchema,
} from "@trigger.dev/core/v3";
import { BatchId, sanitizeQueueName } from "@trigger.dev/core/v3/isomorphic";
import type { BatchItem, RunEngine } from "@internal/run-engine";
import { prisma, type PrismaClientOrTransaction } from "~/db.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { ServiceValidationError, WithRunEngine } from "../../v3/services/baseService.server";
import { BatchPayloadProcessor } from "../concerns/batchPayloads.server";
import { getMaximumSizeForEnvironment } from "../concerns/queues.server";

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
   * Parse a batch friendly ID to its internal ID format.
   * Throws a ServiceValidationError with 400 status if the ID is malformed.
   */
  private parseBatchFriendlyId(friendlyId: string): string {
    try {
      return BatchId.fromFriendlyId(friendlyId);
    } catch {
      throw new ServiceValidationError(`Invalid batchFriendlyId: ${friendlyId}`, 400);
    }
  }

  /**
   * Resolve the queue name for a batch item.
   * Uses explicit queue name if provided, otherwise falls back to task default queue.
   */
  private resolveQueueName(item: BatchItemNDJSON): string {
    // Check for explicit queue name in options
    const explicitQueue = item.options?.queue;
    if (explicitQueue) {
      // Handle both string and object forms
      if (typeof explicitQueue === "string") {
        return sanitizeQueueName(explicitQueue) || `task/${item.task}`;
      }
      if (typeof explicitQueue === "object" && "name" in explicitQueue) {
        const name = (explicitQueue as { name: unknown }).name;
        if (typeof name === "string") {
          return sanitizeQueueName(name) || `task/${item.task}`;
        }
      }
    }

    // Default to task-based queue name
    return sanitizeQueueName(`task/${item.task}`) || `task/${item.task}`;
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
        const batchId = this.parseBatchFriendlyId(batchFriendlyId);

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

        // Get maximum queue size limit for this environment
        const maximumQueueSize = getMaximumSizeForEnvironment(environment);

        // Track projected additions per queue for limit validation
        // Map of queue_name -> { currentSize: number, projectedAdditions: number }
        const queueSizeTracking = new Map<
          string,
          { currentSize: number; projectedAdditions: number }
        >();

        let itemsAccepted = 0;
        let itemsDeduplicated = 0;
        let itemsSkipped = 0;
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

          // Validate queue size limit before enqueuing
          if (maximumQueueSize !== undefined) {
            const queueName = this.resolveQueueName(item);

            // Get or initialize tracking for this queue
            let tracking = queueSizeTracking.get(queueName);
            if (!tracking) {
              // Fetch current queue size from Redis (first time seeing this queue)
              const currentSize = await this._engine.lengthOfQueue(environment, queueName);
              tracking = { currentSize, projectedAdditions: 0 };
              queueSizeTracking.set(queueName, tracking);
            }

            // Check if adding this item would exceed the limit
            const projectedTotal =
              tracking.currentSize + tracking.projectedAdditions + 1;

            if (projectedTotal > maximumQueueSize) {
              logger.warn("Skipping batch item due to queue size limit", {
                batchId: batchFriendlyId,
                queueName,
                currentSize: tracking.currentSize,
                projectedAdditions: tracking.projectedAdditions,
                maximumQueueSize,
                itemIndex: item.index,
              });

              // Skip this item - don't enqueue it
              itemsSkipped++;
              continue;
            }

            // Increment projected additions for this queue
            tracking.projectedAdditions++;
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

        // Calculate expected count accounting for skipped items
        const expectedAfterSkips = batch.runCount - itemsSkipped;

        // Validate we received the expected number of items (minus skipped ones)
        if (enqueuedCount !== expectedAfterSkips) {
          logger.warn("Batch item count mismatch", {
            batchId: batchFriendlyId,
            originalExpected: batch.runCount,
            expectedAfterSkips,
            received: enqueuedCount,
            itemsAccepted,
            itemsDeduplicated,
            itemsSkipped,
          });

          // Don't seal the batch if count doesn't match
          // Return sealed: false so client knows to retry with missing items
          return {
            id: batchFriendlyId,
            itemsAccepted,
            itemsDeduplicated,
            itemsSkipped: itemsSkipped > 0 ? itemsSkipped : undefined,
            sealed: false,
            enqueuedCount,
            expectedCount: batch.runCount,
            runCount: batch.runCount,
          };
        }

        // If items were skipped, update the batch's runCount to match actual enqueued count
        // This ensures the batch completes correctly with fewer runs
        if (itemsSkipped > 0) {
          await this._engine.updateBatchRunCount(batchId, enqueuedCount);

          logger.info("Updated batch runCount due to skipped items", {
            batchId: batchFriendlyId,
            originalRunCount: batch.runCount,
            newRunCount: enqueuedCount,
            itemsSkipped,
          });
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
            // Also update runCount in Postgres if items were skipped
            ...(itemsSkipped > 0 ? { runCount: enqueuedCount } : {}),
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
              itemsSkipped,
              envId: environment.id,
            });

            span.setAttribute("itemsAccepted", itemsAccepted);
            span.setAttribute("itemsDeduplicated", itemsDeduplicated);
            span.setAttribute("itemsSkipped", itemsSkipped);
            span.setAttribute("sealedByConcurrentRequest", true);

            return {
              id: batchFriendlyId,
              itemsAccepted,
              itemsDeduplicated,
              itemsSkipped: itemsSkipped > 0 ? itemsSkipped : undefined,
              sealed: true,
              runCount: itemsSkipped > 0 ? enqueuedCount : batch.runCount,
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
          itemsSkipped,
          totalEnqueued: enqueuedCount,
          envId: environment.id,
        });

        span.setAttribute("itemsAccepted", itemsAccepted);
        span.setAttribute("itemsDeduplicated", itemsDeduplicated);
        span.setAttribute("itemsSkipped", itemsSkipped);

        return {
          id: batchFriendlyId,
          itemsAccepted,
          itemsDeduplicated,
          itemsSkipped: itemsSkipped > 0 ? itemsSkipped : undefined,
          sealed: true,
          runCount: itemsSkipped > 0 ? enqueuedCount : batch.runCount,
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
 * Uses byte-buffer accumulation to:
 * - Prevent OOM from unbounded string buffers
 * - Properly handle multibyte UTF-8 characters across chunk boundaries
 * - Check size limits on raw bytes before decoding
 *
 * @param maxItemBytes - Maximum allowed bytes per line (item)
 * @returns TransformStream that outputs parsed JSON objects
 */
export function createNdjsonParserStream(
  maxItemBytes: number
): TransformStream<Uint8Array, unknown> {
  // Single decoder instance, reused for all lines
  const decoder = new TextDecoder("utf-8", { fatal: true });

  // Byte buffer: array of chunks with tracked total length
  let chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let lineNumber = 0;

  const NEWLINE_BYTE = 0x0a; // '\n'

  /**
   * Concatenate all chunks into a single Uint8Array
   */
  function concatenateChunks(): Uint8Array {
    if (chunks.length === 0) {
      return new Uint8Array(0);
    }
    if (chunks.length === 1) {
      return chunks[0];
    }
    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  /**
   * Find the index of the first newline byte in the buffer.
   * Returns -1 if not found.
   */
  function findNewlineIndex(): number {
    let globalIndex = 0;
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.byteLength; i++) {
        if (chunk[i] === NEWLINE_BYTE) {
          return globalIndex + i;
        }
      }
      globalIndex += chunk.byteLength;
    }
    return -1;
  }

  /**
   * Extract bytes from the buffer up to (but not including) the given index,
   * and remove those bytes plus the delimiter from the buffer.
   */
  function extractLine(newlineIndex: number): Uint8Array {
    const fullBuffer = concatenateChunks();
    const lineBytes = fullBuffer.slice(0, newlineIndex);
    const remaining = fullBuffer.slice(newlineIndex + 1); // Skip the newline

    // Reset buffer with remaining bytes
    if (remaining.byteLength > 0) {
      chunks = [remaining];
      totalBytes = remaining.byteLength;
    } else {
      chunks = [];
      totalBytes = 0;
    }

    return lineBytes;
  }

  /**
   * Parse a line from bytes, handling whitespace trimming.
   * Returns the parsed object or null for empty lines.
   */
  function parseLine(
    lineBytes: Uint8Array,
    controller: TransformStreamDefaultController<unknown>
  ): void {
    lineNumber++;

    // Decode the line bytes (stream: false since this is a complete line)
    let lineText: string;
    try {
      lineText = decoder.decode(lineBytes, { stream: false });
    } catch (err) {
      throw new Error(`Invalid UTF-8 at line ${lineNumber}: ${(err as Error).message}`);
    }

    const trimmed = lineText.trim();
    if (!trimmed) {
      return; // Skip empty lines
    }

    try {
      const obj = JSON.parse(trimmed);
      controller.enqueue(obj);
    } catch (err) {
      throw new Error(`Invalid JSON at line ${lineNumber}: ${(err as Error).message}`);
    }
  }

  return new TransformStream<Uint8Array, unknown>({
    transform(chunk, controller) {
      // Append chunk to buffer
      chunks.push(chunk);
      totalBytes += chunk.byteLength;

      // Process all complete lines in the buffer
      let newlineIndex: number;
      while ((newlineIndex = findNewlineIndex()) !== -1) {
        // Check size limit BEFORE extracting/decoding (bytes up to newline)
        if (newlineIndex > maxItemBytes) {
          throw new Error(
            `Item at line ${
              lineNumber + 1
            } exceeds maximum size of ${maxItemBytes} bytes (actual: ${newlineIndex})`
          );
        }

        const lineBytes = extractLine(newlineIndex);
        parseLine(lineBytes, controller);
      }

      // Check if the remaining buffer (incomplete line) exceeds the limit
      // This prevents OOM from a single huge line without newlines
      if (totalBytes > maxItemBytes) {
        throw new Error(
          `Item at line ${
            lineNumber + 1
          } exceeds maximum size of ${maxItemBytes} bytes (buffered: ${totalBytes}, no newline found)`
        );
      }
    },

    flush(controller) {
      // Flush any remaining bytes from the decoder's internal state
      // This handles multibyte characters that may have been split across chunks
      decoder.decode(new Uint8Array(0), { stream: false });

      // Process any remaining buffered data (no trailing newline case)
      if (totalBytes === 0) {
        return;
      }

      // Check size limit before processing final line
      if (totalBytes > maxItemBytes) {
        throw new Error(
          `Item at line ${
            lineNumber + 1
          } exceeds maximum size of ${maxItemBytes} bytes (actual: ${totalBytes})`
        );
      }

      const finalBytes = concatenateChunks();
      parseLine(finalBytes, controller);
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
