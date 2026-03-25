import {
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

export type OversizedItemMarker = {
  __batchItemError: "OVERSIZED";
  index: number;
  task: string;
  actualSize: number;
  maxSize: number;
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

        let itemsAccepted = 0;
        let itemsDeduplicated = 0;
        let lastIndex = -1;

        // Process items from the stream
        for await (const rawItem of itemsIterator) {
          // Check for oversized item markers from the NDJSON parser
          if (rawItem && typeof rawItem === "object" && "__batchItemError" in rawItem) {
            const marker = rawItem as OversizedItemMarker;
            const itemIndex = marker.index >= 0 ? marker.index : lastIndex + 1;

            const errorMessage = `Batch item payload is too large (${(marker.actualSize / 1024).toFixed(1)} KB). Maximum allowed size is ${(marker.maxSize / 1024).toFixed(1)} KB. Reduce the payload size or offload large data to external storage.`;

            // Enqueue with __error metadata - processItemCallback will detect this
            // and use TriggerFailedTaskService to create a pre-failed run
            const batchItem: BatchItem = {
              task: marker.task,
              payload: "{}",
              payloadType: "application/json",
              options: {
                __error: errorMessage,
                __errorCode: "PAYLOAD_TOO_LARGE",
              },
            };

            const result = await this._engine.enqueueBatchItem(
              batchId,
              environment.id,
              itemIndex,
              batchItem
            );

            if (result.enqueued) {
              itemsAccepted++;
            } else {
              itemsDeduplicated++;
            }
            lastIndex = itemIndex;
            continue;
          }

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
          // The batch queue consumers may have already processed all items and
          // cleaned up the Redis keys before we got here (especially likely when
          // items include pre-failed runs that complete instantly). Check if the
          // batch was already sealed/completed in Postgres.
          const currentBatch = await this._prisma.batchTaskRun.findUnique({
            where: { id: batchId },
            select: { sealed: true, status: true },
          });

          if (currentBatch?.sealed) {
            logger.info("Batch already sealed before count check (fast completion)", {
              batchId: batchFriendlyId,
              itemsAccepted,
              itemsDeduplicated,
              enqueuedCount,
              expectedCount: batch.runCount,
              batchStatus: currentBatch.status,
            });

            return {
              id: batchFriendlyId,
              itemsAccepted,
              itemsDeduplicated,
              sealed: true,
              runCount: batch.runCount,
            };
          }

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
            runCount: batch.runCount,
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
              runCount: batch.runCount,
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
          runCount: batch.runCount,
        };
      }
    );
  }
}

/**
 * Extract `index` and `task` from raw JSON bytes without decoding the full line.
 * Scans at most 512 bytes, tracking JSON nesting depth to only match top-level keys.
 */
export function extractIndexAndTask(bytes: Uint8Array): { index: number; task: string } {
  let index = -1;
  let task = "unknown";
  let depth = 0;
  let foundIndex = false;
  let foundTask = false;
  const limit = Math.min(bytes.byteLength, 512);

  const QUOTE = 0x22; // "
  const COLON = 0x3a; // :
  const LBRACE = 0x7b; // {
  const RBRACE = 0x7d; // }
  const LBRACKET = 0x5b; // [
  const RBRACKET = 0x5d; // ]
  const BACKSLASH = 0x5c; // \

  // Byte patterns for "index" and "task" (without quotes)
  const INDEX_BYTES = [0x69, 0x6e, 0x64, 0x65, 0x78]; // index
  const TASK_BYTES = [0x74, 0x61, 0x73, 0x6b]; // task

  let i = 0;
  while (i < limit && !(foundIndex && foundTask)) {
    const b = bytes[i];

    if (b === LBRACE || b === LBRACKET) {
      depth++;
      i++;
      continue;
    }
    if (b === RBRACE || b === RBRACKET) {
      depth--;
      i++;
      continue;
    }

    // Only match keys at depth 1 (top-level object)
    if (b === QUOTE && depth === 1) {
      // Read the key inside quotes
      const keyStart = i + 1;
      let keyEnd = keyStart;
      while (keyEnd < limit && bytes[keyEnd] !== QUOTE) {
        if (bytes[keyEnd] === BACKSLASH) keyEnd++; // skip escaped char
        keyEnd++;
      }

      const keyLen = keyEnd - keyStart;

      // Check if this key matches "index" or "task"
      const isIndex =
        !foundIndex &&
        keyLen === INDEX_BYTES.length &&
        INDEX_BYTES.every((b, j) => bytes[keyStart + j] === b);
      const isTask =
        !foundTask &&
        keyLen === TASK_BYTES.length &&
        TASK_BYTES.every((b, j) => bytes[keyStart + j] === b);

      if (isIndex || isTask) {
        // Skip past closing quote and find colon
        let pos = keyEnd + 1;
        while (pos < limit && bytes[pos] !== COLON) pos++;
        pos++; // skip colon
        // Skip whitespace
        while (pos < limit && (bytes[pos] === 0x20 || bytes[pos] === 0x09)) pos++;

        if (isIndex) {
          // Parse digits
          let num = 0;
          let hasDigit = false;
          while (pos < limit && bytes[pos] >= 0x30 && bytes[pos] <= 0x39) {
            num = num * 10 + (bytes[pos] - 0x30);
            hasDigit = true;
            pos++;
          }
          if (hasDigit) {
            index = num;
            foundIndex = true;
          }
        } else {
          // Parse quoted string value
          if (pos < limit && bytes[pos] === QUOTE) {
            const valStart = pos + 1;
            let valEnd = valStart;
            while (valEnd < limit && bytes[valEnd] !== QUOTE) {
              if (bytes[valEnd] === BACKSLASH) valEnd++;
              valEnd++;
            }
            // Decode just this slice
            try {
              task = new TextDecoder("utf-8", { fatal: true }).decode(
                bytes.slice(valStart, valEnd)
              );
              foundTask = true;
            } catch {
              // Leave as "unknown"
            }
          }
        }
      }

      // Skip past the key's closing quote
      i = keyEnd + 1;
      continue;
    }

    i++;
  }

  return { index, task };
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
  // When an oversized incomplete line is detected (Case 2), we must discard
  // all remaining bytes of that line until the next newline delimiter.
  let skipUntilNewline = false;

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
      // If we're skipping the remainder of an oversized line, scan for the
      // next newline in this chunk and discard everything before it.
      if (skipUntilNewline) {
        const nlPos = chunk.indexOf(NEWLINE_BYTE);
        if (nlPos === -1) {
          // Entire chunk is still part of the oversized line — discard it
          return;
        }
        // Found the newline — keep everything after it
        skipUntilNewline = false;
        const remaining = chunk.slice(nlPos + 1);
        if (remaining.byteLength === 0) {
          return;
        }
        // Replace chunk with the remainder and fall through to normal processing
        chunk = remaining;
      }

      // Append chunk to buffer
      chunks.push(chunk);
      totalBytes += chunk.byteLength;

      // Process all complete lines in the buffer
      let newlineIndex: number;
      while ((newlineIndex = findNewlineIndex()) !== -1) {
        // Check size limit BEFORE extracting/decoding (bytes up to newline)
        if (newlineIndex > maxItemBytes) {
          // Case 1: Complete line exceeds limit - emit marker instead of throwing
          const lineBytes = extractLine(newlineIndex);
          const extracted = extractIndexAndTask(lineBytes);
          const marker: OversizedItemMarker = {
            __batchItemError: "OVERSIZED",
            index: extracted.index,
            task: extracted.task,
            actualSize: newlineIndex,
            maxSize: maxItemBytes,
          };
          controller.enqueue(marker);
          lineNumber++;
          continue;
        }

        const lineBytes = extractLine(newlineIndex);
        parseLine(lineBytes, controller);
      }

      // Check if the remaining buffer (incomplete line) exceeds the limit
      // This prevents OOM from a single huge line without newlines
      if (totalBytes > maxItemBytes) {
        // Case 2: Incomplete line exceeds limit - emit marker instead of throwing
        const extracted = extractIndexAndTask(concatenateChunks());
        const marker: OversizedItemMarker = {
          __batchItemError: "OVERSIZED",
          index: extracted.index,
          task: extracted.task,
          actualSize: totalBytes,
          maxSize: maxItemBytes,
        };
        controller.enqueue(marker);
        lineNumber++;
        // Clear buffer and skip remaining bytes of this oversized line
        // until the next newline delimiter is found in a subsequent chunk
        chunks = [];
        totalBytes = 0;
        skipUntilNewline = true;
        return;
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
        // Case 3: Flush with oversized remaining - emit marker instead of throwing
        const extracted = extractIndexAndTask(concatenateChunks());
        const marker: OversizedItemMarker = {
          __batchItemError: "OVERSIZED",
          index: extracted.index,
          task: extracted.task,
          actualSize: totalBytes,
          maxSize: maxItemBytes,
        };
        controller.enqueue(marker);
        return;
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
