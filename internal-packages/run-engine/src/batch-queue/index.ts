import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";
import { setInterval } from "node:timers/promises";
import { DRRScheduler } from "./drrScheduler.js";
import { BatchQueueFullKeyProducer } from "./keyProducer.js";
import type {
  BatchItem,
  BatchMeta,
  BatchQueueKeyProducer,
  BatchQueueOptions,
  CompleteBatchResult,
  EnqueueBatchOptions,
  ProcessBatchItemCallback,
  BatchCompletionCallback,
} from "./types.js";

export type { BatchQueueOptions, EnqueueBatchOptions, CompleteBatchResult } from "./types.js";
export { BatchQueueFullKeyProducer } from "./keyProducer.js";

/**
 * BatchQueue manages batch trigger processing with fair scheduling using
 * Deficit Round Robin (DRR) algorithm.
 *
 * Key features:
 * - Two-level queue: master queue (environments) -> batch queues (items)
 * - DRR ensures fair processing across environments
 * - Atomic operations using Lua scripts
 * - Graceful error handling with per-item failure tracking
 */
export class BatchQueue {
  private redis: Redis;
  private keys: BatchQueueKeyProducer;
  private scheduler: DRRScheduler;
  private logger: Logger;
  private abortController: AbortController;
  private consumerLoops: Promise<void>[] = [];
  private isRunning = false;

  private processItemCallback?: ProcessBatchItemCallback;
  private completionCallback?: BatchCompletionCallback;

  constructor(private options: BatchQueueOptions) {
    const redisOptions: RedisOptions = {
      host: options.redis.host,
      port: options.redis.port,
      username: options.redis.username,
      password: options.redis.password,
      keyPrefix: options.redis.keyPrefix,
      enableAutoPipelining: options.redis.enableAutoPipelining,
      ...(options.redis.tls ? { tls: {} } : {}),
    };

    this.redis = createRedisClient(redisOptions, {
      onError: (error) => {
        this.logger.error("BatchQueue Redis error", { error: String(error) });
      },
    });

    this.keys = new BatchQueueFullKeyProducer();
    this.logger = new Logger("BatchQueue", "info");
    this.abortController = new AbortController();

    this.scheduler = new DRRScheduler({
      redis: redisOptions,
      keys: this.keys,
      config: options.drr,
      logger: {
        debug: (msg, ctx) => this.logger.debug(msg, ctx),
        error: (msg, ctx) => this.logger.error(msg, ctx),
      },
    });

    this.#registerCommands();

    if (options.startConsumers !== false) {
      this.start();
    }
  }

  /**
   * Set the callback for processing batch items.
   * This is called for each item dequeued from the batch queue.
   */
  onProcessItem(callback: ProcessBatchItemCallback): void {
    this.processItemCallback = callback;
  }

  /**
   * Set the callback for batch completion.
   * This is called when all items in a batch have been processed.
   */
  onBatchComplete(callback: BatchCompletionCallback): void {
    this.completionCallback = callback;
  }

  /**
   * Enqueue a new batch for processing.
   *
   * This stores all batch data in Redis and adds the batch to the processing queue.
   * The batch will be processed by the DRR scheduler consumers.
   */
  async enqueueBatch(options: EnqueueBatchOptions): Promise<void> {
    const now = Date.now();

    // Prepare batch metadata
    const meta: BatchMeta = {
      batchId: options.batchId,
      friendlyId: options.friendlyId,
      environmentId: options.environmentId,
      environmentType: options.environmentType,
      organizationId: options.organizationId,
      projectId: options.projectId,
      runCount: options.items.length,
      createdAt: now,
      parentRunId: options.parentRunId,
      resumeParentOnCompletion: options.resumeParentOnCompletion,
      triggerVersion: options.triggerVersion,
      traceContext: options.traceContext,
      spanParentAsLink: options.spanParentAsLink,
      realtimeStreamsVersion: options.realtimeStreamsVersion,
      idempotencyKey: options.idempotencyKey,
      planType: options.planType,
    };

    // Master queue member is "{envId}:{batchId}"
    const masterQueueMember = this.keys.masterQueueMember(options.environmentId, options.batchId);

    // Use Lua script to atomically enqueue the batch
    await this.redis.enqueueBatch(
      this.keys.batchQueueKey(options.batchId),
      this.keys.batchItemsKey(options.batchId),
      this.keys.batchMetaKey(options.batchId),
      this.keys.masterQueueKey(),
      masterQueueMember,
      now.toString(),
      JSON.stringify(meta),
      ...options.items.flatMap((item, index) => [index.toString(), JSON.stringify(item)])
    );

    this.logger.debug("Batch enqueued", {
      batchId: options.batchId,
      friendlyId: options.friendlyId,
      envId: options.environmentId,
      itemCount: options.items.length,
    });
  }

  /**
   * Get batch metadata.
   */
  async getBatchMeta(batchId: string): Promise<BatchMeta | null> {
    return this.scheduler.getBatchMeta(batchId);
  }

  /**
   * Get the number of remaining items in a batch.
   */
  async getBatchRemainingCount(batchId: string): Promise<number> {
    const queueKey = this.keys.batchQueueKey(batchId);
    return await this.redis.zcard(queueKey);
  }

  /**
   * Get the successful runs for a batch.
   */
  async getBatchRuns(batchId: string): Promise<string[]> {
    return this.scheduler.getSuccessfulRuns(batchId);
  }

  /**
   * Get the failures for a batch.
   */
  async getBatchFailures(batchId: string): Promise<CompleteBatchResult["failures"]> {
    return this.scheduler.getFailures(batchId);
  }

  /**
   * Start the consumer loops.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    for (let i = 0; i < this.options.consumerCount; i++) {
      const loop = this.#runConsumerLoop(i);
      this.consumerLoops.push(loop);
    }

    this.logger.info("BatchQueue consumers started", {
      consumerCount: this.options.consumerCount,
      intervalMs: this.options.consumerIntervalMs,
      drrQuantum: this.options.drr.quantum,
    });
  }

  /**
   * Stop the consumer loops gracefully.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    this.abortController.abort();

    await Promise.allSettled(this.consumerLoops);
    this.consumerLoops = [];

    this.logger.info("BatchQueue consumers stopped");
  }

  /**
   * Close the BatchQueue and all Redis connections.
   */
  async close(): Promise<void> {
    await this.stop();
    await this.scheduler.close();
    await this.redis.quit();
  }

  /**
   * Run a consumer loop that processes batches using DRR scheduling.
   */
  async #runConsumerLoop(consumerId: number): Promise<void> {
    const loopId = `consumer-${consumerId}`;

    try {
      for await (const _ of setInterval(this.options.consumerIntervalMs, null, {
        signal: this.abortController.signal,
      })) {
        if (!this.processItemCallback) {
          this.logger.debug("No process item callback set, skipping iteration", { loopId });
          continue;
        }

        try {
          await this.#processIteration(loopId);
        } catch (error) {
          this.logger.error("Error in consumer iteration", {
            loopId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.logger.debug("Consumer loop aborted", { loopId });
        return;
      }
      throw error;
    }
  }

  /**
   * Process a single DRR iteration.
   */
  async #processIteration(loopId: string): Promise<void> {
    const dequeued = await this.scheduler.performDRRIteration();

    if (dequeued.length === 0) {
      return;
    }

    this.logger.debug("DRR iteration dequeued items", {
      loopId,
      itemCount: dequeued.length,
    });

    for (const result of dequeued) {
      await this.#processItem(result);
    }
  }

  /**
   * Process a single dequeued item.
   * Uses processed count (not isBatchComplete from dequeue) to determine when to finalize.
   * This prevents race conditions when multiple consumers process items concurrently.
   */
  async #processItem(dequeued: {
    envId: string;
    batchId: string;
    itemIndex: number;
    item: BatchItem;
    meta: BatchMeta;
    isBatchComplete: boolean;
    envHasMoreBatches: boolean;
  }): Promise<void> {
    const { batchId, itemIndex, item, meta } = dequeued;

    if (!this.processItemCallback) {
      this.logger.error("No process item callback set", { batchId, itemIndex });
      return;
    }

    let processedCount: number;

    try {
      const result = await this.processItemCallback({
        batchId,
        friendlyId: meta.friendlyId,
        itemIndex,
        item,
        meta,
      });

      if (result.success) {
        processedCount = await this.scheduler.recordSuccess(batchId, result.runId);
        this.logger.debug("Batch item processed successfully", {
          batchId,
          itemIndex,
          runId: result.runId,
          processedCount,
          expectedCount: meta.runCount,
        });
      } else {
        const payloadStr =
          typeof item.payload === "string" ? item.payload : JSON.stringify(item.payload);
        processedCount = await this.scheduler.recordFailure(batchId, {
          index: itemIndex,
          taskIdentifier: item.task,
          payload: payloadStr?.substring(0, 1000), // Truncate large payloads
          options: item.options as Record<string, unknown>,
          error: result.error,
          errorCode: result.errorCode,
        });
        this.logger.error("Batch item processing failed", {
          batchId,
          itemIndex,
          error: result.error,
          processedCount,
          expectedCount: meta.runCount,
        });
      }
    } catch (error) {
      // Unexpected error during processing
      const payloadStr =
        typeof item.payload === "string" ? item.payload : JSON.stringify(item.payload);
      processedCount = await this.scheduler.recordFailure(batchId, {
        index: itemIndex,
        taskIdentifier: item.task,
        payload: payloadStr?.substring(0, 1000),
        options: item.options as Record<string, unknown>,
        error: error instanceof Error ? error.message : String(error),
        errorCode: "UNEXPECTED_ERROR",
      });
      this.logger.error("Unexpected error processing batch item", {
        batchId,
        itemIndex,
        error: error instanceof Error ? error.message : String(error),
        processedCount,
        expectedCount: meta.runCount,
      });
    }

    // Check if all items have been processed using atomic counter
    // This is safe even with multiple concurrent consumers
    if (processedCount === meta.runCount) {
      this.logger.debug("All items processed, finalizing batch", {
        batchId,
        processedCount,
        expectedCount: meta.runCount,
      });
      await this.#finalizeBatch(batchId, meta);
    }
  }

  /**
   * Finalize a completed batch: gather results and call completion callback.
   */
  async #finalizeBatch(batchId: string, meta: BatchMeta): Promise<void> {
    const runIds = await this.scheduler.getSuccessfulRuns(batchId);
    const failures = await this.scheduler.getFailures(batchId);

    const result: CompleteBatchResult = {
      batchId,
      runIds,
      successfulRunCount: runIds.length,
      failedRunCount: failures.length,
      failures,
    };

    this.logger.info("Batch completed", {
      batchId,
      friendlyId: meta.friendlyId,
      successfulRunCount: result.successfulRunCount,
      failedRunCount: result.failedRunCount,
    });

    if (this.completionCallback) {
      try {
        await this.completionCallback(result);
      } catch (error) {
        this.logger.error("Error in batch completion callback", {
          batchId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Clean up Redis keys for this batch
    await this.scheduler.cleanupBatch(batchId);
  }

  #registerCommands() {
    // Atomic enqueue of a batch with all its items
    this.redis.defineCommand("enqueueBatch", {
      numberOfKeys: 4,
      lua: `
local batchQueueKey = KEYS[1]
local batchItemsKey = KEYS[2]
local batchMetaKey = KEYS[3]
local masterQueueKey = KEYS[4]

local masterQueueMember = ARGV[1]
local now = tonumber(ARGV[2])
local metaJson = ARGV[3]

-- Store batch metadata
redis.call('SET', batchMetaKey, metaJson)

-- Store items in hash and add to queue
-- Items are passed as pairs: [index1, item1, index2, item2, ...]
for i = 4, #ARGV, 2 do
  local itemIndex = ARGV[i]
  local itemJson = ARGV[i + 1]
  
  -- Add to items hash
  redis.call('HSET', batchItemsKey, itemIndex, itemJson)
  
  -- Add to queue sorted set (score = index for ordered processing)
  redis.call('ZADD', batchQueueKey, tonumber(itemIndex), itemIndex)
end

-- Add batch to master queue (member is "{envId}:{batchId}", scored by creation time)
redis.call('ZADD', masterQueueKey, now, masterQueueMember)

return 1
      `,
    });
  }
}

// Extend Redis interface to include our custom command
declare module "@internal/redis" {
  interface RedisCommander<Context> {
    enqueueBatch(
      batchQueueKey: string,
      batchItemsKey: string,
      batchMetaKey: string,
      masterQueueKey: string,
      masterQueueMember: string,
      now: string,
      metaJson: string,
      ...itemPairs: string[]
    ): Promise<number>;
  }
}
