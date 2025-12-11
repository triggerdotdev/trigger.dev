import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import type { Counter, Histogram, Meter } from "@internal/tracing";
import {
  FairQueue,
  DRRScheduler,
  CallbackFairQueueKeyProducer,
  type FairQueueOptions,
} from "@trigger.dev/redis-worker";
import { Logger } from "@trigger.dev/core/logger";
import type {
  BatchCompletionCallback,
  BatchItem,
  BatchItemPayload,
  BatchMeta,
  BatchQueueOptions,
  CompleteBatchResult,
  InitializeBatchOptions,
  ProcessBatchItemCallback,
} from "./types.js";
import { BatchItemPayload as BatchItemPayloadSchema } from "./types.js";
import { BatchCompletionTracker } from "./completionTracker.js";

export type { BatchQueueOptions, InitializeBatchOptions, CompleteBatchResult } from "./types.js";
export { BatchCompletionTracker } from "./completionTracker.js";

/**
 * BatchQueue manages batch trigger processing with fair scheduling using
 * Deficit Round Robin (DRR) algorithm.
 *
 * This implementation uses FairQueue from @trigger.dev/redis-worker internally
 * for message queueing and fair scheduling. Batch completion tracking is handled
 * separately via BatchCompletionTracker.
 *
 * Key features:
 * - Fair processing across environments via DRR
 * - Atomic operations using Lua scripts
 * - Graceful error handling with per-item failure tracking
 * - Each batch becomes a FairQueue "queue" (queueId = batchId, tenantId = envId)
 * - OpenTelemetry metrics for observability
 */
// Redis key for environment concurrency limits
const ENV_CONCURRENCY_KEY_PREFIX = "batch:env_concurrency";

export class BatchQueue {
  private fairQueue: FairQueue<typeof BatchItemPayloadSchema>;
  private completionTracker: BatchCompletionTracker;
  private logger: Logger;
  private concurrencyRedis: import("@internal/redis").Redis;
  private defaultConcurrency: number;

  private processItemCallback?: ProcessBatchItemCallback;
  private completionCallback?: BatchCompletionCallback;

  // Metrics
  private batchesEnqueuedCounter?: Counter;
  private itemsEnqueuedCounter?: Counter;
  private itemsProcessedCounter?: Counter;
  private itemsFailedCounter?: Counter;
  private batchCompletedCounter?: Counter;
  private batchProcessingDurationHistogram?: Histogram;
  private itemQueueTimeHistogram?: Histogram;

  constructor(private options: BatchQueueOptions) {
    this.logger = options.logger
      ? new Logger("BatchQueue", "info")
      : new Logger("BatchQueue", "info");
    this.defaultConcurrency = options.defaultConcurrency ?? 10;

    // Initialize metrics if meter is provided
    if (options.meter) {
      this.#initializeMetrics(options.meter);
    }

    // Create key producer that extracts envId as tenantId from batchId
    // Queue IDs are formatted as: env:{envId}:batch:{batchId}
    const keyProducer = new CallbackFairQueueKeyProducer({
      prefix: "batch",
      extractTenantId: (queueId: string) => {
        // Format: env:{envId}:batch:{batchId}
        const parts = queueId.split(":");
        if (parts.length >= 2 && parts[0] === "env" && parts[1]) {
          return parts[1];
        }
        return queueId;
      },
      extractGroupId: (groupName: string, queueId: string) => {
        const parts = queueId.split(":");
        // Extract envId for the "tenant" concurrency group
        if (groupName === "tenant" && parts.length >= 2 && parts[0] === "env" && parts[1]) {
          return parts[1];
        }
        return "";
      },
    });

    // Create DRR scheduler
    const redisOptions: RedisOptions = {
      host: options.redis.host,
      port: options.redis.port,
      username: options.redis.username,
      password: options.redis.password,
      keyPrefix: options.redis.keyPrefix,
      enableAutoPipelining: options.redis.enableAutoPipelining,
      ...(options.redis.tls ? { tls: {} } : {}),
    };

    // Create a separate Redis client for concurrency lookups
    this.concurrencyRedis = createRedisClient(redisOptions);

    const scheduler = new DRRScheduler({
      redis: redisOptions,
      keys: keyProducer,
      quantum: options.drr.quantum,
      maxDeficit: options.drr.maxDeficit,
      logger: {
        debug: (msg, ctx) => this.logger.debug(msg, ctx),
        error: (msg, ctx) => this.logger.error(msg, ctx),
      },
    });

    // Create FairQueue with telemetry and environment-based concurrency limiting
    const fairQueueOptions: FairQueueOptions<typeof BatchItemPayloadSchema> = {
      redis: redisOptions,
      keys: keyProducer,
      scheduler,
      payloadSchema: BatchItemPayloadSchema,
      validateOnEnqueue: false, // We control the payload
      shardCount: 1, // Batches don't need sharding
      consumerCount: options.consumerCount,
      consumerIntervalMs: options.consumerIntervalMs,
      visibilityTimeoutMs: 60_000, // 1 minute for batch item processing
      startConsumers: false, // We control when to start
      cooloff: {
        enabled: true,
        threshold: 5,
        periodMs: 5_000,
      },
      // Concurrency group based on tenant (environment)
      // This limits how many batch items can be processed concurrently per environment
      // Items wait in queue until capacity frees up
      // Note: Must use "tenant" as the group name - this is what FairQueue expects
      concurrencyGroups: [
        {
          name: "tenant",
          extractGroupId: (queue) => queue.tenantId, // tenantId = envId
          defaultLimit: this.defaultConcurrency,
          getLimit: async (envId: string) => {
            return this.getEnvConcurrency(envId);
          },
        },
      ],
      // Optional global rate limiter to limit max items/sec across all consumers
      globalRateLimiter: options.globalRateLimiter,
      // No retry for batch items - failures are recorded and batch completes
      // Omit retry config entirely to disable retry and DLQ
      logger: this.logger,
      tracer: options.tracer,
      meter: options.meter,
      name: "batch-queue",
    };

    this.fairQueue = new FairQueue(fairQueueOptions);

    // Create completion tracker
    this.completionTracker = new BatchCompletionTracker({
      redis: redisOptions,
      logger: {
        debug: (msg, ctx) => this.logger.debug(msg, ctx),
        info: (msg, ctx) => this.logger.info(msg, ctx),
        error: (msg, ctx) => this.logger.error(msg, ctx),
      },
    });

    // Set up message handler
    this.fairQueue.onMessage(async (ctx) => {
      await this.#handleMessage(ctx);
    });

    // Register telemetry gauge callbacks for observable metrics
    // Note: observedTenants is not provided since tenant list is dynamic
    this.fairQueue.registerTelemetryGauges();

    if (options.startConsumers !== false) {
      this.start();
    }
  }

  // ============================================================================
  // Public API - Callbacks
  // ============================================================================

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

  // ============================================================================
  // Public API - Enqueueing (2-Phase API)
  // ============================================================================

  /**
   * Initialize a batch for 2-phase processing (Phase 1).
   *
   * This stores batch metadata in the completion tracker WITHOUT enqueueing
   * any items. Items are streamed separately via enqueueBatchItem().
   *
   * Use this for the v3 streaming batch API where items are sent via NDJSON stream.
   */
  async initializeBatch(options: InitializeBatchOptions): Promise<void> {
    const now = Date.now();

    // Prepare batch metadata
    const meta: BatchMeta = {
      batchId: options.batchId,
      friendlyId: options.friendlyId,
      environmentId: options.environmentId,
      environmentType: options.environmentType,
      organizationId: options.organizationId,
      projectId: options.projectId,
      runCount: options.runCount,
      createdAt: now,
      parentRunId: options.parentRunId,
      resumeParentOnCompletion: options.resumeParentOnCompletion,
      triggerVersion: options.triggerVersion,
      traceContext: options.traceContext,
      spanParentAsLink: options.spanParentAsLink,
      realtimeStreamsVersion: options.realtimeStreamsVersion,
      idempotencyKey: options.idempotencyKey,
      processingConcurrency: options.processingConcurrency,
    };

    // Store metadata in completion tracker
    await this.completionTracker.storeMeta(options.batchId, meta);

    // Store per-environment concurrency limit if provided
    // This is used by the ConcurrencyManager to limit concurrent processing
    if (options.processingConcurrency !== undefined) {
      await this.storeEnvConcurrency(options.environmentId, options.processingConcurrency);
    }

    // Record metric
    this.batchesEnqueuedCounter?.add(1, {
      envId: options.environmentId,
      itemCount: options.runCount,
      streaming: true,
    });

    this.logger.debug("Batch initialized for streaming", {
      batchId: options.batchId,
      friendlyId: options.friendlyId,
      envId: options.environmentId,
      runCount: options.runCount,
      processingConcurrency: options.processingConcurrency,
    });
  }

  /**
   * Enqueue a single item to an existing batch (Phase 2).
   *
   * This is used for streaming batch item ingestion in the v3 API.
   * Returns whether the item was enqueued (true) or deduplicated (false).
   *
   * @param batchId - The batch ID (internal format)
   * @param envId - The environment ID (needed for queue routing)
   * @param itemIndex - Zero-based index of this item
   * @param item - The batch item to enqueue
   * @returns Object with enqueued status
   */
  async enqueueBatchItem(
    batchId: string,
    envId: string,
    itemIndex: number,
    item: BatchItem
  ): Promise<{ enqueued: boolean }> {
    // Get batch metadata to verify it exists and get friendlyId
    const meta = await this.completionTracker.getMeta(batchId);
    if (!meta) {
      throw new Error(`Batch ${batchId} not found or not initialized`);
    }

    // Atomically check and mark as enqueued for idempotency
    const isNewItem = await this.completionTracker.markItemEnqueued(batchId, itemIndex);
    if (!isNewItem) {
      // Item was already enqueued, deduplicate
      this.logger.debug("Batch item deduplicated", { batchId, itemIndex });
      return { enqueued: false };
    }

    // Create queue ID in format: env:{envId}:batch:{batchId}
    const queueId = this.#makeQueueId(envId, batchId);

    // Build message payload
    const payload: BatchItemPayload = {
      batchId,
      friendlyId: meta.friendlyId,
      itemIndex,
      item,
    };

    // Enqueue single message
    await this.fairQueue.enqueue({
      queueId,
      tenantId: envId,
      payload,
      timestamp: meta.createdAt + itemIndex, // Preserve ordering by index
      metadata: {
        batchId,
        friendlyId: meta.friendlyId,
        envId,
      },
    });

    // Record metric
    this.itemsEnqueuedCounter?.add(1, { envId });

    this.logger.debug("Batch item enqueued", {
      batchId,
      itemIndex,
      task: item.task,
    });

    return { enqueued: true };
  }

  /**
   * Get the count of items that have been enqueued for a batch.
   * Useful for progress tracking during streaming ingestion.
   */
  async getEnqueuedCount(batchId: string): Promise<number> {
    return this.completionTracker.getEnqueuedCount(batchId);
  }

  // ============================================================================
  // Public API - Query
  // ============================================================================

  /**
   * Get batch metadata.
   */
  async getBatchMeta(batchId: string): Promise<BatchMeta | null> {
    return this.completionTracker.getMeta(batchId);
  }

  /**
   * Get the number of remaining items in a batch.
   */
  async getBatchRemainingCount(batchId: string): Promise<number> {
    const meta = await this.completionTracker.getMeta(batchId);
    if (!meta) return 0;

    const processedCount = await this.completionTracker.getProcessedCount(batchId);
    return Math.max(0, meta.runCount - processedCount);
  }

  /**
   * Get the successful runs for a batch.
   */
  async getBatchRuns(batchId: string): Promise<string[]> {
    return this.completionTracker.getSuccessfulRuns(batchId);
  }

  /**
   * Get the failures for a batch.
   */
  async getBatchFailures(batchId: string): Promise<CompleteBatchResult["failures"]> {
    return this.completionTracker.getFailures(batchId);
  }

  /**
   * Get the live processed count for a batch from Redis.
   * This is useful for displaying real-time progress in the UI.
   */
  async getBatchProcessedCount(batchId: string): Promise<number> {
    return this.completionTracker.getProcessedCount(batchId);
  }

  /**
   * Get the live progress for a batch from Redis.
   * Returns success count, failure count, and processed count.
   * This is useful for displaying real-time progress in the UI.
   */
  async getBatchProgress(batchId: string): Promise<{
    successCount: number;
    failureCount: number;
    processedCount: number;
  }> {
    const [successfulRuns, failures, processedCount] = await Promise.all([
      this.completionTracker.getSuccessfulRuns(batchId),
      this.completionTracker.getFailures(batchId),
      this.completionTracker.getProcessedCount(batchId),
    ]);

    return {
      successCount: successfulRuns.length,
      failureCount: failures.length,
      processedCount,
    };
  }

  // ============================================================================
  // Public API - Lifecycle
  // ============================================================================

  /**
   * Start the consumer loops.
   */
  start(): void {
    this.fairQueue.start();
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
    await this.fairQueue.stop();
    this.logger.info("BatchQueue consumers stopped");
  }

  /**
   * Close the BatchQueue and all Redis connections.
   */
  async close(): Promise<void> {
    await this.fairQueue.close();
    await this.completionTracker.close();
    await this.concurrencyRedis.quit();
  }

  // ============================================================================
  // Private - Environment Concurrency Management
  // ============================================================================

  /**
   * Store the concurrency limit for an environment.
   * This is called when a batch is initialized with a specific concurrency limit.
   * The limit expires after 24 hours to prevent stale data.
   */
  private async storeEnvConcurrency(envId: string, concurrency: number): Promise<void> {
    const key = `${ENV_CONCURRENCY_KEY_PREFIX}:${envId}`;
    // Set with 24 hour expiry - batches should complete well before this
    await this.concurrencyRedis.set(key, concurrency.toString(), "EX", 86400);

    this.logger.debug("Stored environment concurrency limit", { envId, concurrency });
  }

  /**
   * Get the concurrency limit for an environment.
   * Returns the stored limit or the default if not set.
   */
  private async getEnvConcurrency(envId: string): Promise<number> {
    const key = `${ENV_CONCURRENCY_KEY_PREFIX}:${envId}`;
    const stored = await this.concurrencyRedis.get(key);

    if (stored) {
      const limit = parseInt(stored, 10);
      if (!isNaN(limit) && limit > 0) {
        return limit;
      }
    }

    return this.defaultConcurrency;
  }

  // ============================================================================
  // Private - Metrics Initialization
  // ============================================================================

  #initializeMetrics(meter: Meter): void {
    this.batchesEnqueuedCounter = meter.createCounter("batch_queue.batches_enqueued", {
      description: "Number of batches enqueued",
      unit: "batches",
    });

    this.itemsProcessedCounter = meter.createCounter("batch_queue.items_processed", {
      description: "Number of batch items successfully processed",
      unit: "items",
    });

    this.itemsFailedCounter = meter.createCounter("batch_queue.items_failed", {
      description: "Number of batch items that failed processing",
      unit: "items",
    });

    this.batchCompletedCounter = meter.createCounter("batch_queue.batches_completed", {
      description: "Number of batches completed",
      unit: "batches",
    });

    this.batchProcessingDurationHistogram = meter.createHistogram(
      "batch_queue.batch_processing_duration",
      {
        description: "Duration from batch creation to completion",
        unit: "ms",
      }
    );

    this.itemsEnqueuedCounter = meter.createCounter("batch_queue.items_enqueued", {
      description: "Number of batch items enqueued",
      unit: "items",
    });

    this.itemQueueTimeHistogram = meter.createHistogram("batch_queue.item_queue_time", {
      description: "Time from item enqueue to processing start",
      unit: "ms",
    });
  }

  // ============================================================================
  // Private - Message Handling
  // ============================================================================

  async #handleMessage(ctx: {
    message: {
      id: string;
      queueId: string;
      payload: BatchItemPayload;
      timestamp: number;
      attempt: number;
    };
    queue: { id: string; tenantId: string };
    consumerId: string;
    heartbeat: () => Promise<boolean>;
    complete: () => Promise<void>;
    release: () => Promise<void>;
    fail: (error?: Error) => Promise<void>;
  }): Promise<void> {
    const { batchId, friendlyId, itemIndex, item } = ctx.message.payload;

    // Record queue time metric (time from enqueue to processing)
    const queueTimeMs = Date.now() - ctx.message.timestamp;
    this.itemQueueTimeHistogram?.record(queueTimeMs, { envId: ctx.queue.tenantId });

    this.logger.debug("Processing batch item", {
      batchId,
      friendlyId,
      itemIndex,
      task: item.task,
      consumerId: ctx.consumerId,
      attempt: ctx.message.attempt,
      queueTimeMs,
    });

    if (!this.processItemCallback) {
      this.logger.error("No process item callback set", { batchId, itemIndex });
      // Still complete the message to avoid blocking
      await ctx.complete();
      return;
    }

    // Get batch metadata
    const meta = await this.completionTracker.getMeta(batchId);
    if (!meta) {
      this.logger.error("Batch metadata not found", { batchId, itemIndex });
      await ctx.complete();
      return;
    }

    let processedCount: number;

    try {
      const result = await this.processItemCallback({
        batchId,
        friendlyId,
        itemIndex,
        item,
        meta,
      });

      if (result.success) {
        // Pass itemIndex for idempotency - prevents double-counting on redelivery
        processedCount = await this.completionTracker.recordSuccess(
          batchId,
          result.runId,
          itemIndex
        );
        this.itemsProcessedCounter?.add(1, { envId: meta.environmentId });
        this.logger.debug("Batch item processed successfully", {
          batchId,
          itemIndex,
          runId: result.runId,
          processedCount,
          expectedCount: meta.runCount,
        });
      } else {
        // For offloaded payloads (payloadType: "application/store"), payload is already an R2 path
        // For inline payloads, store the full payload - it's under the offload threshold anyway
        const payloadStr =
          typeof item.payload === "string" ? item.payload : JSON.stringify(item.payload);
        processedCount = await this.completionTracker.recordFailure(batchId, {
          index: itemIndex,
          taskIdentifier: item.task,
          payload: payloadStr,
          options: item.options as Record<string, unknown>,
          error: result.error,
          errorCode: result.errorCode,
        });
        this.itemsFailedCounter?.add(1, { envId: meta.environmentId, errorCode: result.errorCode });
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
      // For offloaded payloads, payload is an R2 path; for inline payloads, store full payload
      const payloadStr =
        typeof item.payload === "string" ? item.payload : JSON.stringify(item.payload);
      processedCount = await this.completionTracker.recordFailure(batchId, {
        index: itemIndex,
        taskIdentifier: item.task,
        payload: payloadStr,
        options: item.options as Record<string, unknown>,
        error: error instanceof Error ? error.message : String(error),
        errorCode: "UNEXPECTED_ERROR",
      });
      this.itemsFailedCounter?.add(1, { envId: meta.environmentId, errorCode: "UNEXPECTED_ERROR" });
      this.logger.error("Unexpected error processing batch item", {
        batchId,
        itemIndex,
        error: error instanceof Error ? error.message : String(error),
        processedCount,
        expectedCount: meta.runCount,
      });
    }

    // Complete the FairQueue message (no retry for batch items)
    // This must happen after recording success/failure to ensure the counter
    // is updated before the message is considered done
    await ctx.complete();

    // Check if all items have been processed using atomic counter
    // This is safe even with multiple concurrent consumers because
    // the processedCount is atomically incremented and we only trigger
    // finalization when we see the exact final count
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
    const result = await this.completionTracker.getCompletionResult(batchId);

    // Record metrics
    this.batchCompletedCounter?.add(1, {
      envId: meta.environmentId,
      hasFailures: result.failedRunCount > 0,
    });

    const processingDuration = Date.now() - meta.createdAt;
    this.batchProcessingDurationHistogram?.record(processingDuration, {
      envId: meta.environmentId,
      itemCount: meta.runCount,
    });

    this.logger.info("Batch completed", {
      batchId,
      friendlyId: meta.friendlyId,
      successfulRunCount: result.successfulRunCount,
      failedRunCount: result.failedRunCount,
      processingDurationMs: processingDuration,
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
    await this.completionTracker.cleanup(batchId);
  }

  // ============================================================================
  // Private - Helpers
  // ============================================================================

  /**
   * Create a queue ID from environment ID and batch ID.
   * Format: env:{envId}:batch:{batchId}
   */
  #makeQueueId(envId: string, batchId: string): string {
    return `env:${envId}:batch:${batchId}`;
  }
}
