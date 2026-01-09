import { createRedisClient, type Redis } from "@internal/redis";
import {
  startSpan,
  type Counter,
  type Histogram,
  type Meter,
  type ObservableGauge,
  type Span,
  type Tracer,
} from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import {
  BatchedSpanManager,
  CallbackFairQueueKeyProducer,
  DRRScheduler,
  FairQueue,
  isAbortError,
  WorkerQueueManager,
  type FairQueueOptions,
} from "@trigger.dev/redis-worker";
import { BatchCompletionTracker } from "./completionTracker.js";
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

export { BatchCompletionTracker } from "./completionTracker.js";
export type { BatchQueueOptions, CompleteBatchResult, InitializeBatchOptions } from "./types.js";

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

// Single worker queue ID for all batch items
// BatchQueue uses a single shared worker queue - FairQueue handles fair scheduling,
// then all messages are routed to this queue for BatchQueue's own consumer loop.
const BATCH_WORKER_QUEUE_ID = "batch-worker-queue";

export class BatchQueue {
  private fairQueue: FairQueue<typeof BatchItemPayloadSchema>;
  private workerQueueManager: WorkerQueueManager;
  private completionTracker: BatchCompletionTracker;
  private logger: Logger;
  private tracer?: Tracer;
  private concurrencyRedis: Redis;
  private defaultConcurrency: number;

  private processItemCallback?: ProcessBatchItemCallback;
  private completionCallback?: BatchCompletionCallback;

  // Consumer loop state
  private isRunning = false;
  private abortController: AbortController;
  private workerQueueConsumerLoops: Promise<void>[] = [];
  private workerQueueBlockingTimeoutSeconds: number;
  private batchedSpanManager: BatchedSpanManager;

  // Metrics
  private batchesEnqueuedCounter?: Counter;
  private itemsEnqueuedCounter?: Counter;
  private itemsProcessedCounter?: Counter;
  private itemsFailedCounter?: Counter;
  private batchCompletedCounter?: Counter;
  private batchProcessingDurationHistogram?: Histogram;
  private itemQueueTimeHistogram?: Histogram;
  private workerQueueLengthGauge?: ObservableGauge;

  constructor(private options: BatchQueueOptions) {
    this.logger = options.logger ?? new Logger("BatchQueue", options.logLevel ?? "info");
    this.tracer = options.tracer;
    this.defaultConcurrency = options.defaultConcurrency ?? 10;
    this.abortController = new AbortController();
    this.workerQueueBlockingTimeoutSeconds = options.workerQueueBlockingTimeoutSeconds ?? 10;

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

    // Create a separate Redis client for concurrency lookups
    this.concurrencyRedis = createRedisClient(options.redis);

    const scheduler = new DRRScheduler({
      redis: options.redis,
      keys: keyProducer,
      quantum: options.drr.quantum,
      maxDeficit: options.drr.maxDeficit,
      masterQueueLimit: options.drr.masterQueueLimit,
      logger: {
        debug: (msg, ctx) => this.logger.debug(msg, ctx),
        error: (msg, ctx) => this.logger.error(msg, ctx),
      },
    });

    // Create FairQueue with telemetry and environment-based concurrency limiting
    // FairQueue handles fair scheduling and routes messages to the batch worker queue
    // BatchQueue runs its own consumer loop to process messages from the worker queue
    const fairQueueOptions: FairQueueOptions<typeof BatchItemPayloadSchema> = {
      redis: options.redis,
      keys: keyProducer,
      scheduler,
      payloadSchema: BatchItemPayloadSchema,
      validateOnEnqueue: false, // We control the payload
      shardCount: options.shardCount ?? 1,
      consumerCount: options.consumerCount,
      consumerIntervalMs: options.consumerIntervalMs,
      visibilityTimeoutMs: 60_000, // 1 minute for batch item processing
      startConsumers: false, // We control when to start
      cooloff: {
        enabled: true,
        threshold: 5,
        periodMs: 5_000,
      },
      // Worker queue configuration - FairQueue routes all messages to our single worker queue
      workerQueue: {
        // All batch items go to the same worker queue - BatchQueue handles consumption
        resolveWorkerQueue: () => BATCH_WORKER_QUEUE_ID,
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

    // Create worker queue manager for consuming from the batch worker queue
    this.workerQueueManager = new WorkerQueueManager({
      redis: options.redis,
      keys: keyProducer,
      logger: {
        debug: (msg, ctx) => this.logger.debug(msg, ctx),
        error: (msg, ctx) => this.logger.error(msg, ctx),
      },
    });

    // Initialize batched span manager for worker queue consumer tracing
    this.batchedSpanManager = new BatchedSpanManager({
      tracer: options.tracer,
      name: "batch-queue-worker",
      maxIterations: options.consumerTraceMaxIterations ?? 1000,
      timeoutSeconds: options.consumerTraceTimeoutSeconds ?? 60,
    });

    // Create completion tracker
    this.completionTracker = new BatchCompletionTracker({
      redis: options.redis,
      logger: {
        debug: (msg, ctx) => this.logger.debug(msg, ctx),
        info: (msg, ctx) => this.logger.info(msg, ctx),
        error: (msg, ctx) => this.logger.error(msg, ctx),
      },
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
      environment_type: options.environmentType,
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
    this.itemsEnqueuedCounter?.add(1, { environment_type: meta.environmentType });

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
   * FairQueue runs the master queue consumer loop (claim and push to worker queue).
   * BatchQueue runs its own worker queue consumer loops to process messages.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    // Start FairQueue's master queue consumers (routes messages to worker queue)
    this.fairQueue.start();

    // Start worker queue consumer loops
    for (let consumerId = 0; consumerId < this.options.consumerCount; consumerId++) {
      const loop = this.#runWorkerQueueConsumerLoop(consumerId);
      this.workerQueueConsumerLoops.push(loop);
    }

    this.logger.info("BatchQueue consumers started", {
      consumerCount: this.options.consumerCount,
      intervalMs: this.options.consumerIntervalMs,
      drrQuantum: this.options.drr.quantum,
      workerQueueId: BATCH_WORKER_QUEUE_ID,
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

    // Stop FairQueue's master queue consumers
    await this.fairQueue.stop();

    // Wait for worker queue consumer loops to finish
    await Promise.allSettled(this.workerQueueConsumerLoops);
    this.workerQueueConsumerLoops = [];

    this.logger.info("BatchQueue consumers stopped");
  }

  /**
   * Close the BatchQueue and all Redis connections.
   */
  async close(): Promise<void> {
    await this.stop();

    // Clean up any remaining batched spans (safety net for spans not cleaned up by consumer loops)
    this.batchedSpanManager.cleanupAll();

    await this.fairQueue.close();
    await this.workerQueueManager.close();
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

    this.workerQueueLengthGauge = meter.createObservableGauge("batch_queue.worker_queue.length", {
      description: "Number of items waiting in the batch worker queue",
      unit: "items",
    });

    this.workerQueueLengthGauge.addCallback(async (observableResult) => {
      const length = await this.workerQueueManager.getLength(BATCH_WORKER_QUEUE_ID);
      observableResult.observe(length);
    });
  }

  // ============================================================================
  // Private - Worker Queue Consumer Loop
  // ============================================================================

  /**
   * Run a worker queue consumer loop.
   * This pops messages from the batch worker queue and processes them.
   */
  async #runWorkerQueueConsumerLoop(consumerId: number): Promise<void> {
    const loopId = `batch-worker-${consumerId}`;

    // Initialize batched span tracking for this loop
    this.batchedSpanManager.initializeLoop(loopId);

    try {
      while (this.isRunning) {
        if (!this.processItemCallback) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }

        try {
          await this.batchedSpanManager.withBatchedSpan(
            loopId,
            async (span) => {
              span.setAttribute("consumer_id", consumerId);

              // Blocking pop from worker queue
              const messageKey = await this.workerQueueManager.blockingPop(
                BATCH_WORKER_QUEUE_ID,
                this.workerQueueBlockingTimeoutSeconds,
                this.abortController.signal
              );

              if (!messageKey) {
                this.batchedSpanManager.incrementStat(loopId, "empty_iterations");
                return false; // Timeout, no work
              }

              // Parse message key (format: "messageId:queueId")
              const colonIndex = messageKey.indexOf(":");
              if (colonIndex === -1) {
                this.logger.error("Invalid message key format", { messageKey });
                this.batchedSpanManager.incrementStat(loopId, "invalid_message_keys");
                return false;
              }

              const messageId = messageKey.substring(0, colonIndex);
              const queueId = messageKey.substring(colonIndex + 1);

              await this.#handleMessage(loopId, messageId, queueId);
              this.batchedSpanManager.incrementStat(loopId, "messages_processed");
              return true; // Had work
            },
            {
              iterationSpanName: "processWorkerQueueMessage",
              attributes: { consumer_id: consumerId },
            }
          );
        } catch (error) {
          if (this.abortController.signal.aborted) {
            break;
          }
          this.logger.error("Worker queue consumer error", {
            loopId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.batchedSpanManager.markForRotation(loopId);
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        this.logger.debug("Worker queue consumer aborted", { loopId });
        this.batchedSpanManager.cleanup(loopId);
        return;
      }
      throw error;
    } finally {
      this.batchedSpanManager.cleanup(loopId);
    }
  }

  // ============================================================================
  // Private - Message Handling
  // ============================================================================

  async #handleMessage(consumerId: string, messageId: string, queueId: string): Promise<void> {
    // Get message data from FairQueue's in-flight storage
    const storedMessage = await this.fairQueue.getMessageData(messageId, queueId);

    if (!storedMessage) {
      this.logger.error("Message not found in in-flight data", { messageId, queueId });
      await this.fairQueue.completeMessage(messageId, queueId);
      return;
    }

    const { batchId, friendlyId, itemIndex, item } = storedMessage.payload;

    return this.#startSpan("BatchQueue.handleMessage", async (span) => {
      span?.setAttributes({
        "batch.id": batchId,
        "batch.friendlyId": friendlyId,
        "batch.itemIndex": itemIndex,
        "batch.task": item.task,
        "batch.consumerId": consumerId,
        "batch.attempt": storedMessage.attempt,
      });

      // Calculate queue time (time from enqueue to processing)
      const queueTimeMs = Date.now() - storedMessage.timestamp;
      span?.setAttribute("batch.queueTimeMs", queueTimeMs);

      this.logger.debug("Processing batch item", {
        batchId,
        friendlyId,
        itemIndex,
        task: item.task,
        consumerId,
        attempt: storedMessage.attempt,
        queueTimeMs,
      });

      if (!this.processItemCallback) {
        this.logger.error("No process item callback set", { batchId, itemIndex });
        // Still complete the message to avoid blocking
        await this.fairQueue.completeMessage(messageId, queueId);
        return;
      }

      // Get batch metadata
      const meta = await this.#startSpan("BatchQueue.getMeta", async () => {
        return this.completionTracker.getMeta(batchId);
      });

      if (!meta) {
        this.logger.error("Batch metadata not found", { batchId, itemIndex });
        await this.fairQueue.completeMessage(messageId, queueId);
        return;
      }

      // Record queue time metric (requires meta for environment_type)
      this.itemQueueTimeHistogram?.record(queueTimeMs, { environment_type: meta.environmentType });

      span?.setAttributes({
        "batch.runCount": meta.runCount,
        "batch.environmentId": meta.environmentId,
      });

      let processedCount: number;

      try {
        const result = await this.#startSpan(
          "BatchQueue.processItemCallback",
          async (innerSpan) => {
            innerSpan?.setAttributes({
              "batch.id": batchId,
              "batch.itemIndex": itemIndex,
              "batch.task": item.task,
            });
            return this.processItemCallback!({
              batchId,
              friendlyId,
              itemIndex,
              item,
              meta,
            });
          }
        );

        if (result.success) {
          span?.setAttribute("batch.result", "success");
          span?.setAttribute("batch.runId", result.runId);

          // Pass itemIndex for idempotency - prevents double-counting on redelivery
          processedCount = await this.#startSpan("BatchQueue.recordSuccess", async () => {
            return this.completionTracker.recordSuccess(batchId, result.runId, itemIndex);
          });

          this.itemsProcessedCounter?.add(1, { environment_type: meta.environmentType });
          this.logger.debug("Batch item processed successfully", {
            batchId,
            itemIndex,
            runId: result.runId,
            processedCount,
            expectedCount: meta.runCount,
          });
        } else {
          span?.setAttribute("batch.result", "failure");
          span?.setAttribute("batch.error", result.error);
          if (result.errorCode) {
            span?.setAttribute("batch.errorCode", result.errorCode);
          }

          // For offloaded payloads (payloadType: "application/store"), payload is already an R2 path
          // For inline payloads, store the full payload - it's under the offload threshold anyway
          const payloadStr = await this.#startSpan(
            "BatchQueue.serializePayload",
            async (innerSpan) => {
              const str =
                typeof item.payload === "string" ? item.payload : JSON.stringify(item.payload);
              innerSpan?.setAttribute("batch.payloadSize", str.length);
              return str;
            }
          );

          processedCount = await this.#startSpan("BatchQueue.recordFailure", async () => {
            return this.completionTracker.recordFailure(batchId, {
              index: itemIndex,
              taskIdentifier: item.task,
              payload: payloadStr,
              options: item.options,
              error: result.error,
              errorCode: result.errorCode,
            });
          });

          this.itemsFailedCounter?.add(1, {
            environment_type: meta.environmentType,
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
        span?.setAttribute("batch.result", "unexpected_error");
        span?.setAttribute("batch.error", error instanceof Error ? error.message : String(error));

        // Unexpected error during processing
        // For offloaded payloads, payload is an R2 path; for inline payloads, store full payload
        const payloadStr = await this.#startSpan(
          "BatchQueue.serializePayload",
          async (innerSpan) => {
            const str =
              typeof item.payload === "string" ? item.payload : JSON.stringify(item.payload);
            innerSpan?.setAttribute("batch.payloadSize", str.length);
            return str;
          }
        );

        processedCount = await this.#startSpan("BatchQueue.recordFailure", async () => {
          return this.completionTracker.recordFailure(batchId, {
            index: itemIndex,
            taskIdentifier: item.task,
            payload: payloadStr,
            options: item.options,
            error: error instanceof Error ? error.message : String(error),
            errorCode: "UNEXPECTED_ERROR",
          });
        });

        this.itemsFailedCounter?.add(1, {
          environment_type: meta.environmentType,
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

      span?.setAttribute("batch.processedCount", processedCount);

      // Complete the FairQueue message (no retry for batch items)
      // This must happen after recording success/failure to ensure the counter
      // is updated before the message is considered done
      await this.#startSpan("BatchQueue.completeMessage", async () => {
        return this.fairQueue.completeMessage(messageId, queueId);
      });

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
    });
  }

  /**
   * Finalize a completed batch: gather results and call completion callback.
   */
  async #finalizeBatch(batchId: string, meta: BatchMeta): Promise<void> {
    return this.#startSpan("BatchQueue.finalizeBatch", async (span) => {
      span?.setAttributes({
        "batch.id": batchId,
        "batch.friendlyId": meta.friendlyId,
        "batch.runCount": meta.runCount,
        "batch.environmentId": meta.environmentId,
      });

      const result = await this.#startSpan("BatchQueue.getCompletionResult", async (innerSpan) => {
        const completionResult = await this.completionTracker.getCompletionResult(batchId);
        innerSpan?.setAttributes({
          "batch.successfulRunCount": completionResult.successfulRunCount,
          "batch.failedRunCount": completionResult.failedRunCount,
          "batch.runIdsCount": completionResult.runIds.length,
          "batch.failuresCount": completionResult.failures.length,
        });
        return completionResult;
      });

      span?.setAttributes({
        "batch.successfulRunCount": result.successfulRunCount,
        "batch.failedRunCount": result.failedRunCount,
      });

      // Record metrics
      this.batchCompletedCounter?.add(1, {
        environment_type: meta.environmentType,
        hasFailures: result.failedRunCount > 0,
      });

      const processingDuration = Date.now() - meta.createdAt;
      this.batchProcessingDurationHistogram?.record(processingDuration, {
        environment_type: meta.environmentType,
      });

      span?.setAttribute("batch.processingDurationMs", processingDuration);

      this.logger.info("Batch completed", {
        batchId,
        friendlyId: meta.friendlyId,
        successfulRunCount: result.successfulRunCount,
        failedRunCount: result.failedRunCount,
        processingDurationMs: processingDuration,
      });

      if (this.completionCallback) {
        try {
          await this.#startSpan("BatchQueue.completionCallback", async () => {
            return this.completionCallback!(result);
          });

          // Only cleanup if callback succeeded - preserves Redis data for retry on failure
          await this.#startSpan("BatchQueue.cleanup", async () => {
            return this.completionTracker.cleanup(batchId);
          });
        } catch (error) {
          this.logger.error("Error in batch completion callback", {
            batchId,
            error: error instanceof Error ? error.message : String(error),
          });
          // Re-throw to preserve Redis data and signal failure to callers
          throw error;
        }
      } else {
        // No callback, safe to cleanup
        await this.#startSpan("BatchQueue.cleanup", async () => {
          return this.completionTracker.cleanup(batchId);
        });
      }
    });
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

  /**
   * Helper to start a span if tracer is available.
   * If no tracer is configured, just executes the callback directly.
   */
  async #startSpan<T>(name: string, fn: (span: Span | undefined) => Promise<T>): Promise<T> {
    if (!this.tracer) {
      return fn(undefined);
    }
    return startSpan(this.tracer, name, fn);
  }
}
