import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { SpanKind, type Span } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { nanoid } from "nanoid";
import { setInterval } from "node:timers/promises";
import { type z } from "zod";
import { ConcurrencyManager } from "./concurrency.js";
import { MasterQueue } from "./masterQueue.js";
import { TenantDispatch } from "./tenantDispatch.js";
import { type RetryStrategy, ExponentialBackoffRetry } from "./retry.js";
import { isAbortError } from "../utils.js";
import {
  FairQueueTelemetry,
  FairQueueAttributes,
  MessagingAttributes,
  BatchedSpanManager,
} from "./telemetry.js";
import type {
  ConcurrencyGroupConfig,
  DeadLetterMessage,
  DispatchSchedulerContext,
  EnqueueBatchOptions,
  EnqueueOptions,
  FairQueueKeyProducer,
  FairQueueOptions,
  FairScheduler,
  GlobalRateLimiter,
  QueueCooloffState,
  QueueDescriptor,
  SchedulerContext,
  StoredMessage,
  TenantQueues,
} from "./types.js";
import { VisibilityManager } from "./visibility.js";
import { WorkerQueueManager } from "./workerQueue.js";

// Re-export all types and components
export * from "./types.js";
export * from "./keyProducer.js";
export * from "./masterQueue.js";
export * from "./concurrency.js";
export * from "./visibility.js";
export * from "./workerQueue.js";
export * from "./scheduler.js";
export * from "./schedulers/index.js";
export * from "./retry.js";
export * from "./telemetry.js";
export * from "./tenantDispatch.js";

/**
 * FairQueue is the main orchestrator for fair queue message routing.
 *
 * FairQueue handles:
 * - Master queue with sharding (using jump consistent hash)
 * - Fair scheduling via pluggable schedulers
 * - Multi-level concurrency limiting
 * - Visibility timeouts with heartbeats
 * - Routing messages to worker queues
 * - Retry strategies with dead letter queue
 * - OpenTelemetry tracing and metrics
 *
 * External consumers are responsible for:
 * - Running their own worker queue consumer loops
 * - Calling complete/release/fail APIs after processing
 *
 * @typeParam TPayloadSchema - Zod schema for message payload validation
 */
export class FairQueue<TPayloadSchema extends z.ZodTypeAny = z.ZodUnknown> {
  private redis: Redis;
  private keys: FairQueueKeyProducer;
  private scheduler: FairScheduler;
  private masterQueue: MasterQueue;
  private concurrencyManager?: ConcurrencyManager;
  private visibilityManager: VisibilityManager;
  private workerQueueManager: WorkerQueueManager;
  private telemetry: FairQueueTelemetry;
  private logger: Logger;

  // Configuration
  private payloadSchema?: TPayloadSchema;
  private validateOnEnqueue: boolean;
  private retryStrategy?: RetryStrategy;
  private deadLetterQueueEnabled: boolean;
  private shardCount: number;
  private consumerCount: number;
  private consumerIntervalMs: number;
  private visibilityTimeoutMs: number;
  private heartbeatIntervalMs: number;
  private reclaimIntervalMs: number;
  private workerQueueResolver: (message: StoredMessage<z.infer<TPayloadSchema>>) => string;
  private batchClaimSize: number;

  // Cooloff state
  private cooloffEnabled: boolean;
  private cooloffThreshold: number;
  private cooloffPeriodMs: number;
  private maxCooloffStatesSize: number;
  private queueCooloffStates = new Map<string, QueueCooloffState>();

  // Global rate limiter
  private globalRateLimiter?: GlobalRateLimiter;

  // Consumer tracing
  private consumerTraceMaxIterations: number;
  private consumerTraceTimeoutSeconds: number;
  private batchedSpanManager: BatchedSpanManager;

  // Runtime state
  private isRunning = false;
  private abortController: AbortController;
  private masterQueueConsumerLoops: Promise<void>[] = [];
  private reclaimLoop?: Promise<void>;

  // Queue descriptor cache for message processing
  private queueDescriptorCache = new Map<string, QueueDescriptor>();

  // Two-level tenant dispatch
  private tenantDispatch: TenantDispatch;

  constructor(private options: FairQueueOptions<TPayloadSchema>) {
    this.redis = createRedisClient(options.redis);
    this.keys = options.keys;
    this.scheduler = options.scheduler;
    this.logger = options.logger ?? new Logger("FairQueue", "info");
    this.abortController = new AbortController();

    // Payload validation
    this.payloadSchema = options.payloadSchema;
    this.validateOnEnqueue = options.validateOnEnqueue ?? false;

    // Retry and DLQ
    this.retryStrategy = options.retry?.strategy;
    this.deadLetterQueueEnabled = options.retry?.deadLetterQueue ?? true;

    // Configuration
    this.shardCount = options.shardCount ?? 1;
    this.consumerCount = options.consumerCount ?? 1;
    this.consumerIntervalMs = options.consumerIntervalMs ?? 100;
    this.visibilityTimeoutMs = options.visibilityTimeoutMs ?? 30_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? this.visibilityTimeoutMs / 3;
    this.reclaimIntervalMs = options.reclaimIntervalMs ?? 5_000;

    // Worker queue resolver (required)
    this.workerQueueResolver = options.workerQueue.resolveWorkerQueue;

    // Batch claiming
    this.batchClaimSize = options.batchClaimSize ?? 10;

    // Cooloff
    this.cooloffEnabled = options.cooloff?.enabled ?? true;
    this.cooloffThreshold = options.cooloff?.threshold ?? 10;
    this.cooloffPeriodMs = options.cooloff?.periodMs ?? 10_000;
    this.maxCooloffStatesSize = options.cooloff?.maxStatesSize ?? 1000;

    // Global rate limiter
    this.globalRateLimiter = options.globalRateLimiter;

    // Consumer tracing
    this.consumerTraceMaxIterations = options.consumerTraceMaxIterations ?? 500;
    this.consumerTraceTimeoutSeconds = options.consumerTraceTimeoutSeconds ?? 60;

    // Initialize telemetry
    this.telemetry = new FairQueueTelemetry({
      tracer: options.tracer,
      meter: options.meter,
      name: options.name ?? "fairqueue",
    });

    // Initialize batched span manager for consumer tracing
    this.batchedSpanManager = new BatchedSpanManager({
      tracer: options.tracer,
      name: options.name ?? "fairqueue",
      maxIterations: this.consumerTraceMaxIterations,
      timeoutSeconds: this.consumerTraceTimeoutSeconds,
      getDynamicAttributes: () => ({
        "cache.descriptor_size": this.queueDescriptorCache.size,
        "cache.cooloff_states_size": this.queueCooloffStates.size,
      }),
    });

    // Initialize components
    this.masterQueue = new MasterQueue({
      redis: options.redis,
      keys: options.keys,
      shardCount: this.shardCount,
    });

    this.tenantDispatch = new TenantDispatch({
      redis: options.redis,
      keys: options.keys,
      shardCount: this.shardCount,
    });


    if (options.concurrencyGroups && options.concurrencyGroups.length > 0) {
      this.concurrencyManager = new ConcurrencyManager({
        redis: options.redis,
        keys: options.keys,
        groups: options.concurrencyGroups,
      });
    }

    this.visibilityManager = new VisibilityManager({
      redis: options.redis,
      keys: options.keys,
      shardCount: this.shardCount,
      defaultTimeoutMs: this.visibilityTimeoutMs,
      logger: {
        debug: (msg, ctx) => this.logger.debug(msg, ctx),
        error: (msg, ctx) => this.logger.error(msg, ctx),
      },
    });

    // Worker queue manager for pushing messages to worker queues
    this.workerQueueManager = new WorkerQueueManager({
      redis: options.redis,
      keys: options.keys,
      logger: {
        debug: (msg, ctx) => this.logger.debug(msg, ctx),
        error: (msg, ctx) => this.logger.error(msg, ctx),
      },
    });

    this.#registerCommands();

    // Auto-start consumers if not disabled
    if (options.startConsumers !== false) {
      this.start();
    }
  }

  // ============================================================================
  // Public API - Telemetry
  // ============================================================================

  /**
   * Register observable gauge callbacks for telemetry.
   * Call this after FairQueue is created to enable gauge metrics.
   *
   * @param options.observedTenants - List of tenant IDs to observe for DLQ metrics
   */
  registerTelemetryGauges(options?: { observedTenants?: string[] }): void {
    this.telemetry.registerGaugeCallbacks({
      getMasterQueueLength: async (shardId: number) => {
        return await this.masterQueue.getShardQueueCount(shardId);
      },
      getDispatchLength: async (shardId: number) => {
        return await this.tenantDispatch.getShardTenantCount(shardId);
      },
      getInflightCount: async (shardId: number) => {
        return await this.visibilityManager.getInflightCount(shardId);
      },
      getDLQLength: async (tenantId: string) => {
        return await this.getDeadLetterQueueLength(tenantId);
      },
      shardCount: this.shardCount,
      observedTenants: options?.observedTenants,
    });
  }

  // ============================================================================
  // Public API - Enqueueing
  // ============================================================================

  /**
   * Enqueue a single message to a queue.
   */
  async enqueue(options: EnqueueOptions<z.infer<TPayloadSchema>>): Promise<string> {
    return this.telemetry.trace(
      "enqueue",
      async (span) => {
        const messageId = options.messageId ?? nanoid();
        const timestamp = options.timestamp ?? Date.now();
        const queueKey = this.keys.queueKey(options.queueId);
        const queueItemsKey = this.keys.queueItemsKey(options.queueId);
        const dispatchShardId = this.tenantDispatch.getShardForTenant(options.tenantId);
        const tenantQueueIndexKey = this.keys.tenantQueueIndexKey(options.tenantId);
        const dispatchKey = this.keys.dispatchKey(dispatchShardId);

        // Validate payload if schema provided and validation enabled
        if (this.validateOnEnqueue && this.payloadSchema) {
          const result = this.payloadSchema.safeParse(options.payload);
          if (!result.success) {
            throw new Error(`Payload validation failed: ${result.error.message}`);
          }
        }

        // Store queue descriptor for later use
        const descriptor: QueueDescriptor = {
          id: options.queueId,
          tenantId: options.tenantId,
          metadata: options.metadata ?? {},
        };
        this.queueDescriptorCache.set(options.queueId, descriptor);

        // Build stored message
        const storedMessage: StoredMessage<z.infer<TPayloadSchema>> = {
          id: messageId,
          queueId: options.queueId,
          tenantId: options.tenantId,
          payload: options.payload,
          timestamp,
          attempt: 1,
          workerQueue: this.workerQueueResolver
            ? this.workerQueueResolver({
                id: messageId,
                queueId: options.queueId,
                tenantId: options.tenantId,
                payload: options.payload,
                timestamp,
                attempt: 1,
                metadata: options.metadata,
              })
            : undefined,
          metadata: options.metadata,
        };

        // Use atomic Lua script to enqueue and update tenant dispatch indexes
        await this.redis.enqueueMessageAtomicV2(
          queueKey,
          queueItemsKey,
          tenantQueueIndexKey,
          dispatchKey,
          options.queueId,
          messageId,
          timestamp.toString(),
          JSON.stringify(storedMessage),
          options.tenantId
        );

        span.setAttributes({
          [FairQueueAttributes.QUEUE_ID]: options.queueId,
          [FairQueueAttributes.TENANT_ID]: options.tenantId,
          [FairQueueAttributes.MESSAGE_ID]: messageId,
          [FairQueueAttributes.SHARD_ID]: dispatchShardId.toString(),
        });

        this.telemetry.recordEnqueue();

        this.logger.debug("Message enqueued", {
          queueId: options.queueId,
          messageId,
          timestamp,
        });

        return messageId;
      },
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          [MessagingAttributes.OPERATION]: "publish",
        },
      }
    );
  }

  /**
   * Enqueue multiple messages to a queue.
   */
  async enqueueBatch(options: EnqueueBatchOptions<z.infer<TPayloadSchema>>): Promise<string[]> {
    return this.telemetry.trace(
      "enqueueBatch",
      async (span) => {
        const queueKey = this.keys.queueKey(options.queueId);
        const queueItemsKey = this.keys.queueItemsKey(options.queueId);
        const dispatchShardId = this.tenantDispatch.getShardForTenant(options.tenantId);
        const tenantQueueIndexKey = this.keys.tenantQueueIndexKey(options.tenantId);
        const dispatchKey = this.keys.dispatchKey(dispatchShardId);
        const now = Date.now();

        // Store queue descriptor
        const descriptor: QueueDescriptor = {
          id: options.queueId,
          tenantId: options.tenantId,
          metadata: options.metadata ?? {},
        };
        this.queueDescriptorCache.set(options.queueId, descriptor);

        const messageIds: string[] = [];
        const args: string[] = [];

        for (const message of options.messages) {
          const messageId = message.messageId ?? nanoid();
          const timestamp = message.timestamp ?? now;

          // Validate if enabled
          if (this.validateOnEnqueue && this.payloadSchema) {
            const result = this.payloadSchema.safeParse(message.payload);
            if (!result.success) {
              throw new Error(
                `Payload validation failed for message ${messageId}: ${result.error.message}`
              );
            }
          }

          const storedMessage: StoredMessage<z.infer<TPayloadSchema>> = {
            id: messageId,
            queueId: options.queueId,
            tenantId: options.tenantId,
            payload: message.payload,
            timestamp,
            attempt: 1,
            workerQueue: this.workerQueueResolver
              ? this.workerQueueResolver({
                  id: messageId,
                  queueId: options.queueId,
                  tenantId: options.tenantId,
                  payload: message.payload,
                  timestamp,
                  attempt: 1,
                  metadata: options.metadata,
                })
              : undefined,
            metadata: options.metadata,
          };

          messageIds.push(messageId);
          args.push(messageId, timestamp.toString(), JSON.stringify(storedMessage));
        }

        // Use atomic Lua script for batch enqueue with tenant dispatch indexes
        await this.redis.enqueueBatchAtomicV2(
          queueKey,
          queueItemsKey,
          tenantQueueIndexKey,
          dispatchKey,
          options.queueId,
          options.tenantId,
          ...args
        );

        span.setAttributes({
          [FairQueueAttributes.QUEUE_ID]: options.queueId,
          [FairQueueAttributes.TENANT_ID]: options.tenantId,
          [FairQueueAttributes.MESSAGE_COUNT]: messageIds.length,
          [FairQueueAttributes.SHARD_ID]: dispatchShardId.toString(),
        });

        this.telemetry.recordEnqueueBatch(messageIds.length);

        this.logger.debug("Batch enqueued", {
          queueId: options.queueId,
          messageCount: messageIds.length,
        });

        return messageIds;
      },
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          [MessagingAttributes.OPERATION]: "publish",
        },
      }
    );
  }

  // ============================================================================
  // Public API - Dead Letter Queue
  // ============================================================================

  /**
   * Get messages from the dead letter queue for a tenant.
   */
  async getDeadLetterMessages(
    tenantId: string,
    limit: number = 100
  ): Promise<DeadLetterMessage<z.infer<TPayloadSchema>>[]> {
    if (!this.deadLetterQueueEnabled) {
      return [];
    }

    const dlqKey = this.keys.deadLetterQueueKey(tenantId);
    const dlqDataKey = this.keys.deadLetterQueueDataKey(tenantId);

    // Get message IDs with scores (deadLetteredAt timestamps)
    const results = await this.redis.zrange(dlqKey, 0, limit - 1, "WITHSCORES");

    const messages: DeadLetterMessage<z.infer<TPayloadSchema>>[] = [];

    for (let i = 0; i < results.length; i += 2) {
      const messageId = results[i];
      const deadLetteredAtStr = results[i + 1];
      if (!messageId || !deadLetteredAtStr) continue;

      const dataJson = await this.redis.hget(dlqDataKey, messageId);
      if (!dataJson) continue;

      try {
        const data = JSON.parse(dataJson) as DeadLetterMessage<z.infer<TPayloadSchema>>;
        data.deadLetteredAt = parseFloat(deadLetteredAtStr);
        messages.push(data);
      } catch {
        this.logger.error("Failed to parse DLQ message", { messageId, tenantId });
      }
    }

    return messages;
  }

  /**
   * Redrive a message from DLQ back to its original queue.
   */
  async redriveMessage(tenantId: string, messageId: string): Promise<boolean> {
    if (!this.deadLetterQueueEnabled) {
      return false;
    }

    return this.telemetry.trace(
      "redriveMessage",
      async (span) => {
        const dlqKey = this.keys.deadLetterQueueKey(tenantId);
        const dlqDataKey = this.keys.deadLetterQueueDataKey(tenantId);

        // Get the message data
        const dataJson = await this.redis.hget(dlqDataKey, messageId);
        if (!dataJson) {
          return false;
        }

        const dlqMessage = JSON.parse(dataJson) as DeadLetterMessage<z.infer<TPayloadSchema>>;

        // Re-enqueue with reset attempt count
        await this.enqueue({
          queueId: dlqMessage.queueId,
          tenantId: dlqMessage.tenantId,
          payload: dlqMessage.payload,
          messageId: dlqMessage.id,
          timestamp: Date.now(),
        });

        // Remove from DLQ
        const pipeline = this.redis.pipeline();
        pipeline.zrem(dlqKey, messageId);
        pipeline.hdel(dlqDataKey, messageId);
        await pipeline.exec();

        span.setAttributes({
          [FairQueueAttributes.TENANT_ID]: tenantId,
          [FairQueueAttributes.MESSAGE_ID]: messageId,
        });

        this.logger.info("Redrived message from DLQ", { tenantId, messageId });

        return true;
      },
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          [MessagingAttributes.OPERATION]: "redrive",
        },
      }
    );
  }

  /**
   * Redrive all messages from DLQ back to their original queues.
   */
  async redriveAll(tenantId: string): Promise<number> {
    const messages = await this.getDeadLetterMessages(tenantId, 1000);
    let count = 0;

    for (const message of messages) {
      const success = await this.redriveMessage(tenantId, message.id);
      if (success) count++;
    }

    return count;
  }

  /**
   * Purge all messages from a tenant's DLQ.
   */
  async purgeDeadLetterQueue(tenantId: string): Promise<number> {
    if (!this.deadLetterQueueEnabled) {
      return 0;
    }

    const dlqKey = this.keys.deadLetterQueueKey(tenantId);
    const dlqDataKey = this.keys.deadLetterQueueDataKey(tenantId);

    const count = await this.redis.zcard(dlqKey);

    const pipeline = this.redis.pipeline();
    pipeline.del(dlqKey);
    pipeline.del(dlqDataKey);
    await pipeline.exec();

    this.logger.info("Purged DLQ", { tenantId, count });

    return count;
  }

  /**
   * Get the number of messages in a tenant's DLQ.
   */
  async getDeadLetterQueueLength(tenantId: string): Promise<number> {
    if (!this.deadLetterQueueEnabled) {
      return 0;
    }

    const dlqKey = this.keys.deadLetterQueueKey(tenantId);
    return await this.redis.zcard(dlqKey);
  }

  /**
   * Get the size of the in-memory queue descriptor cache.
   * This cache stores metadata for queues that have been enqueued.
   * The cache is cleaned up when queues are fully processed.
   */
  getQueueDescriptorCacheSize(): number {
    return this.queueDescriptorCache.size;
  }

  /**
   * Get the size of the in-memory cooloff states cache.
   * This cache tracks queues that are in cooloff due to repeated failures.
   * The cache is cleaned up when queues are fully processed or cooloff expires.
   */
  getQueueCooloffStatesSize(): number {
    return this.queueCooloffStates.size;
  }

  /**
   * Get all in-memory cache sizes for monitoring.
   * Useful for adding as span attributes.
   */
  getCacheSizes(): { descriptorCacheSize: number; cooloffStatesSize: number } {
    return {
      descriptorCacheSize: this.queueDescriptorCache.size,
      cooloffStatesSize: this.queueCooloffStates.size,
    };
  }

  // ============================================================================
  // Public API - Lifecycle
  // ============================================================================

  /**
   * Start the master queue consumer loops and reclaim loop.
   * FairQueue claims messages and pushes them to worker queues.
   * External consumers are responsible for consuming from worker queues.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    // Start master queue consumers (one per shard)
    // These claim messages from queues and push to worker queues
    for (let shardId = 0; shardId < this.shardCount; shardId++) {
      const loop = this.#runMasterQueueConsumerLoop(shardId);
      this.masterQueueConsumerLoops.push(loop);
    }

    // Start reclaim loop for handling timed-out messages
    this.reclaimLoop = this.#runReclaimLoop();

    this.logger.info("FairQueue started", {
      consumerCount: this.consumerCount,
      shardCount: this.shardCount,
      consumerIntervalMs: this.consumerIntervalMs,
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

    await Promise.allSettled([...this.masterQueueConsumerLoops, this.reclaimLoop]);

    this.masterQueueConsumerLoops = [];
    this.reclaimLoop = undefined;

    this.logger.info("FairQueue stopped");
  }

  /**
   * Close all resources.
   */
  async close(): Promise<void> {
    await this.stop();

    // Clean up any remaining batched spans
    this.batchedSpanManager.cleanupAll();

    await Promise.all([
      this.masterQueue.close(),
      this.tenantDispatch.close(),
      this.concurrencyManager?.close(),
      this.visibilityManager.close(),
      this.workerQueueManager.close(),
      this.scheduler.close?.(),
      this.redis.quit(),
    ]);
  }

  // ============================================================================
  // Public API - Inspection
  // ============================================================================

  /**
   * Get the number of messages in a queue.
   */
  async getQueueLength(queueId: string): Promise<number> {
    const queueKey = this.keys.queueKey(queueId);
    return await this.redis.zcard(queueKey);
  }

  /**
   * Get total tenant count across dispatch shards plus any legacy queues still draining.
   */
  async getTotalQueueCount(): Promise<number> {
    const [dispatchCount, legacyCount] = await Promise.all([
      this.tenantDispatch.getTotalTenantCount(),
      this.masterQueue.getTotalQueueCount(),
    ]);
    return dispatchCount + legacyCount;
  }

  /**
   * Get total in-flight message count.
   */
  async getTotalInflightCount(): Promise<number> {
    return await this.visibilityManager.getTotalInflightCount();
  }

  /**
   * Get the shard ID for a queue.
   */
  getShardForQueue(queueId: string): number {
    return this.masterQueue.getShardForQueue(queueId);
  }

  // ============================================================================
  // Private - Master Queue Consumer Loop (Two-Stage)
  // ============================================================================

  async #runMasterQueueConsumerLoop(shardId: number): Promise<void> {
    const loopId = `master-shard-${shardId}`;

    // Initialize batched span tracking for this loop
    this.batchedSpanManager.initializeLoop(loopId);

    try {
      while (this.isRunning) {
        // Check abort signal
        if (this.abortController.signal.aborted) {
          break;
        }

        let hadWork = false;
        try {
          hadWork = await this.batchedSpanManager.withBatchedSpan(
            loopId,
            async (span) => {
              span.setAttribute("shard_id", shardId);
              return await this.#processShardIteration(loopId, shardId, span);
            },
            {
              iterationSpanName: "processMasterQueueShard",
              attributes: { shard_id: shardId },
            }
          );
        } catch (error) {
          this.logger.error("Master queue consumer error", {
            loopId,
            shardId,
            error: error instanceof Error ? error.message : String(error),
          });
          this.batchedSpanManager.markForRotation(loopId);
        }

        // Wait between iterations to prevent CPU spin
        // Short delay when there's work (yield to event loop), longer delay when idle
        const waitMs = hadWork ? 1 : this.consumerIntervalMs;
        await new Promise<void>((resolve, reject) => {
          const abortHandler = () => {
            clearTimeout(timeout);
            reject(new Error("AbortError"));
          };
          const timeout = setTimeout(() => {
            // Must remove listener when timeout fires, otherwise listeners accumulate
            // (the { once: true } option only removes on abort, not on timeout)
            this.abortController.signal.removeEventListener("abort", abortHandler);
            resolve();
          }, waitMs);
          this.abortController.signal.addEventListener("abort", abortHandler, { once: true });
        });
      }
    } catch (error) {
      if (isAbortError(error)) {
        this.logger.debug("Master queue consumer aborted", { loopId });
        this.batchedSpanManager.cleanup(loopId);
        return;
      }
      throw error;
    } finally {
      this.batchedSpanManager.cleanup(loopId);
    }
  }

  /**
   * Process a shard iteration. Runs both the new tenant dispatch path
   * and the legacy master queue drain path.
   */
  async #processShardIteration(
    loopId: string,
    shardId: number,
    parentSpan?: Span
  ): Promise<boolean> {
    let hadWork = false;

    // Main path: new two-level tenant dispatch (gets full DRR scheduling)
    hadWork = await this.#processDispatchShard(loopId, shardId, parentSpan);

    // Drain path: legacy master queue (simple scheduling, no DRR)
    // Check ZCARD first (O(1)) to skip the drain path when empty
    const legacyCount = await this.masterQueue.getShardQueueCount(shardId);
    if (legacyCount > 0) {
      const drainHadWork = await this.#drainLegacyMasterQueueShard(loopId, shardId, parentSpan);
      hadWork = hadWork || drainHadWork;
    }

    return hadWork;
  }

  /**
   * Main path: process queues using the two-level tenant dispatch index.
   * Level 1: dispatch index → tenantIds. Level 2: per-tenant → queueIds.
   */
  async #processDispatchShard(
    loopId: string,
    shardId: number,
    parentSpan?: Span
  ): Promise<boolean> {
    const dispatchKey = this.keys.dispatchKey(shardId);

    // Get dispatch index size for observability
    const dispatchSize = await this.tenantDispatch.getShardTenantCount(shardId);
    parentSpan?.setAttribute("dispatch_size", dispatchSize);
    this.batchedSpanManager.incrementStat(loopId, "dispatch_size_sum", dispatchSize);

    // Create dispatch-aware scheduler context
    const schedulerContext: DispatchSchedulerContext = {
      ...this.#createSchedulerContext(),
      getQueuesForTenant: async (tenantId: string, limit?: number) => {
        return this.tenantDispatch.getQueuesForTenant(tenantId, limit);
      },
    };

    // Get queues to process from scheduler
    let tenantQueues: TenantQueues[];

    if (this.scheduler.selectQueuesFromDispatch) {
      // Use dispatch-aware scheduler method (DRR with two-level lookup)
      tenantQueues = await this.telemetry.trace(
        "selectQueuesFromDispatch",
        async (span) => {
          span.setAttribute(FairQueueAttributes.SHARD_ID, shardId.toString());
          span.setAttribute(FairQueueAttributes.CONSUMER_ID, loopId);
          span.setAttribute("dispatch_size", dispatchSize);
          const result = await this.scheduler.selectQueuesFromDispatch!(
            dispatchKey,
            loopId,
            schedulerContext
          );
          span.setAttribute("tenant_count", result.length);
          span.setAttribute(
            "queue_count",
            result.reduce((acc, t) => acc + t.queues.length, 0)
          );
          return result;
        },
        { kind: SpanKind.INTERNAL }
      );
    } else {
      // Fallback: read dispatch index, build flat queue list, use legacy selectQueues
      tenantQueues = await this.#fallbackDispatchToLegacyScheduler(
        loopId,
        shardId,
        schedulerContext,
        parentSpan
      );
    }

    if (tenantQueues.length === 0) {
      this.batchedSpanManager.incrementStat(loopId, "empty_iterations");
      return false;
    }

    return this.#processSelectedQueues(loopId, shardId, tenantQueues);
  }

  /**
   * Drain path: process remaining messages from the legacy master queue shard.
   * Uses simple ZRANGEBYSCORE without DRR - just flushing pre-deploy messages.
   */
  async #drainLegacyMasterQueueShard(
    loopId: string,
    shardId: number,
    parentSpan?: Span
  ): Promise<boolean> {
    const masterQueueKey = this.keys.masterQueueKey(shardId);
    const now = Date.now();

    // Simple fetch from old master queue - no DRR needed for drain
    const results = await this.redis.zrangebyscore(
      masterQueueKey,
      "-inf",
      now,
      "WITHSCORES",
      "LIMIT",
      0,
      100
    );

    if (results.length === 0) {
      return false;
    }

    // Parse results into QueueWithScore, group by tenant
    const byTenant = new Map<string, string[]>();
    for (let i = 0; i < results.length; i += 2) {
      const queueId = results[i];
      const _score = results[i + 1];
      if (queueId && _score) {
        const tenantId = this.keys.extractTenantId(queueId);
        const existing = byTenant.get(tenantId) ?? [];
        existing.push(queueId);
        byTenant.set(tenantId, existing);
      }
    }

    // Build TenantQueues, filter at-capacity tenants
    const tenantQueues: TenantQueues[] = [];
    for (const [tenantId, queueIds] of byTenant) {
      if (this.concurrencyManager) {
        const atCapacity = await this.concurrencyManager.isAtCapacity("tenant", tenantId);
        if (atCapacity) continue;
      }
      tenantQueues.push({ tenantId, queues: queueIds });
    }

    if (tenantQueues.length === 0) {
      return false;
    }

    parentSpan?.setAttribute("drain_tenants", tenantQueues.length);
    this.batchedSpanManager.incrementStat(loopId, "drain_tenants", tenantQueues.length);

    return this.#processSelectedQueues(loopId, shardId, tenantQueues);
  }

  /**
   * Fallback for schedulers that don't implement selectQueuesFromDispatch.
   * Reads dispatch index, fetches per-tenant queues, groups by tenant,
   * and filters at-capacity tenants. No DRR deficit tracking in this path.
   */
  async #fallbackDispatchToLegacyScheduler(
    loopId: string,
    shardId: number,
    context: DispatchSchedulerContext,
    parentSpan?: Span
  ): Promise<TenantQueues[]> {
    // Get tenants from dispatch
    const tenants = await this.tenantDispatch.getTenantsFromShard(shardId);
    if (tenants.length === 0) return [];

    // For each tenant, get their queues and build grouped result
    const tenantQueues: TenantQueues[] = [];
    for (const { tenantId } of tenants) {
      if (this.concurrencyManager) {
        const atCapacity = await this.concurrencyManager.isAtCapacity("tenant", tenantId);
        if (atCapacity) continue;
      }
      const queues = await this.tenantDispatch.getQueuesForTenant(tenantId);
      if (queues.length > 0) {
        tenantQueues.push({ tenantId, queues: queues.map((q) => q.queueId) });
      }
    }

    return tenantQueues;
  }

  /**
   * Shared claim loop: process selected queues from either dispatch or drain path.
   * Claims messages and pushes to worker queues.
   */
  async #processSelectedQueues(
    loopId: string,
    shardId: number,
    tenantQueues: TenantQueues[]
  ): Promise<boolean> {
    // Track stats
    this.batchedSpanManager.incrementStat(loopId, "tenants_selected", tenantQueues.length);
    this.batchedSpanManager.incrementStat(
      loopId,
      "queues_selected",
      tenantQueues.reduce((acc, t) => acc + t.queues.length, 0)
    );

    let messagesProcessed = 0;

    for (const { tenantId, queues } of tenantQueues) {
      for (const queueId of queues) {
        // Check cooloff
        if (this.cooloffEnabled && this.#isInCooloff(queueId)) {
          this.batchedSpanManager.incrementStat(loopId, "cooloff_skipped");
          continue;
        }

        // Check tenant capacity before attempting to process
        if (this.concurrencyManager) {
          const isAtCapacity = await this.concurrencyManager.isAtCapacity("tenant", tenantId);
          if (isAtCapacity) {
            this.batchedSpanManager.incrementStat(loopId, "tenant_capacity_skipped");
            break;
          }
        }

        const processedFromQueue = await this.telemetry.trace(
          "claimAndPushToWorkerQueue",
          async (span) => {
            span.setAttribute(FairQueueAttributes.QUEUE_ID, queueId);
            span.setAttribute(FairQueueAttributes.TENANT_ID, tenantId);
            span.setAttribute(FairQueueAttributes.SHARD_ID, shardId.toString());
            const count = await this.#claimAndPushToWorkerQueue(loopId, queueId, tenantId, shardId);
            span.setAttribute("messages_claimed", count);
            return count;
          },
          { kind: SpanKind.INTERNAL }
        );

        if (processedFromQueue > 0) {
          messagesProcessed += processedFromQueue;
          this.batchedSpanManager.incrementStat(loopId, "messages_claimed", processedFromQueue);

          if (this.scheduler.recordProcessedBatch) {
            await this.telemetry.trace(
              "recordProcessedBatch",
              async (span) => {
                span.setAttribute(FairQueueAttributes.QUEUE_ID, queueId);
                span.setAttribute(FairQueueAttributes.TENANT_ID, tenantId);
                span.setAttribute("count", processedFromQueue);
                await this.scheduler.recordProcessedBatch!(tenantId, queueId, processedFromQueue);
              },
              { kind: SpanKind.INTERNAL }
            );
          } else if (this.scheduler.recordProcessed) {
            for (let i = 0; i < processedFromQueue; i++) {
              await this.telemetry.trace(
                "recordProcessed",
                async (span) => {
                  span.setAttribute(FairQueueAttributes.QUEUE_ID, queueId);
                  span.setAttribute(FairQueueAttributes.TENANT_ID, tenantId);
                  await this.scheduler.recordProcessed!(tenantId, queueId);
                },
                { kind: SpanKind.INTERNAL }
              );
            }
          }
        } else {
          this.batchedSpanManager.incrementStat(loopId, "claim_skipped");
        }
      }
    }

    return messagesProcessed > 0;
  }

  async #claimAndPushToWorkerQueue(
    loopId: string,
    queueId: string,
    tenantId: string,
    _consumerShardId: number
  ): Promise<number> {
    // Dispatch shard is tenant-based (tenantId hash), not queue-based.
    // In-flight/master queue shard is queue-based.
    const dispatchShardId = this.tenantDispatch.getShardForTenant(tenantId);
    const queueKey = this.keys.queueKey(queueId);
    const queueItemsKey = this.keys.queueItemsKey(queueId);
    const descriptor = this.queueDescriptorCache.get(queueId) ?? {
      id: queueId,
      tenantId,
      metadata: {},
    };

    // Determine how many messages we can claim based on concurrency
    let maxClaimCount = this.batchClaimSize;
    if (this.concurrencyManager) {
      const availableCapacity = await this.concurrencyManager.getAvailableCapacity(descriptor);
      if (availableCapacity === 0) {
        // Queue at max concurrency - don't increment cooloff here.
        // The outer loop already handles this case (concurrency blocked)
        // and explicitly avoids cooloff for it. Cooloff here causes
        // spurious 5s stalls when capacity races between the tenant
        // pre-check and this per-queue check.
        return 0;
      }
      maxClaimCount = Math.min(maxClaimCount, availableCapacity);
    }

    // Check global rate limit - wait if rate limited
    if (this.globalRateLimiter) {
      const result = await this.globalRateLimiter.limit();
      if (!result.allowed && result.resetAt) {
        const waitMs = Math.max(0, result.resetAt - Date.now());
        if (waitMs > 0) {
          this.logger.debug("Global rate limit reached, waiting", { waitMs, loopId });
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
    }

    // Claim batch of messages with visibility timeout
    const claimedMessages = await this.visibilityManager.claimBatch<
      StoredMessage<z.infer<TPayloadSchema>>
    >(queueId, queueKey, queueItemsKey, loopId, maxClaimCount, this.visibilityTimeoutMs);

    if (claimedMessages.length === 0) {
      // Queue is empty, update both old and new indexes and clean up caches
      await this.#updateAllIndexesAfterDequeue(queueId, tenantId);
      this.queueDescriptorCache.delete(queueId);
      this.queueCooloffStates.delete(queueId);
      return 0;
    }

    let processedCount = 0;

    // Reserve concurrency and push each message to worker queue
    for (let i = 0; i < claimedMessages.length; i++) {
      const message = claimedMessages[i]!;

      // Reserve concurrency slot
      if (this.concurrencyManager) {
        const reserved = await this.concurrencyManager.reserve(descriptor, message.messageId);
        if (!reserved) {
          // Release ALL remaining messages (from index i onward) back to queue
          // This prevents messages from being stranded in the in-flight set
          const tenantQueueIndexKey = this.keys.tenantQueueIndexKey(tenantId);
          const dispatchKey = this.keys.dispatchKey(dispatchShardId);
          await this.visibilityManager.releaseBatch(
            claimedMessages.slice(i),
            queueId,
            queueKey,
            queueItemsKey,
            tenantQueueIndexKey,
            dispatchKey,
            tenantId
          );
          // Stop processing more messages from this queue since we're at capacity
          break;
        }
      }

      // Resolve which worker queue this message should go to
      const workerQueueId = this.workerQueueResolver(message.payload);

      // Push to worker queue with format "messageId:queueId"
      const messageKey = `${message.messageId}:${queueId}`;
      await this.workerQueueManager.push(workerQueueId, messageKey);
      processedCount++;
    }

    if (processedCount > 0) {
      this.#resetCooloff(queueId);
    }

    return processedCount;
  }

  // ============================================================================
  // Public API - Message Lifecycle (for external consumers)
  // ============================================================================

  /**
   * Get message data from in-flight storage.
   * External consumers use this to retrieve the stored message after popping from worker queue.
   *
   * @param messageId - The ID of the message
   * @param queueId - The queue ID the message belongs to
   * @returns The stored message or null if not found
   */
  async getMessageData(
    messageId: string,
    queueId: string
  ): Promise<StoredMessage<z.infer<TPayloadSchema>> | null> {
    const shardId = this.masterQueue.getShardForQueue(queueId);
    const inflightDataKey = this.keys.inflightDataKey(shardId);
    const dataJson = await this.redis.hget(inflightDataKey, messageId);

    if (!dataJson) {
      return null;
    }

    try {
      return JSON.parse(dataJson) as StoredMessage<z.infer<TPayloadSchema>>;
    } catch {
      this.logger.error("Failed to parse message data", { messageId, queueId });
      return null;
    }
  }

  /**
   * Extend the visibility timeout for a message.
   * External consumers should call this periodically during long-running processing.
   *
   * @param messageId - The ID of the message
   * @param queueId - The queue ID the message belongs to
   * @returns true if heartbeat was successful
   */
  async heartbeatMessage(messageId: string, queueId: string): Promise<boolean> {
    return this.visibilityManager.heartbeat(messageId, queueId, this.heartbeatIntervalMs);
  }

  /**
   * Mark a message as successfully processed.
   * This removes the message from in-flight and releases concurrency.
   *
   * @param messageId - The ID of the message
   * @param queueId - The queue ID the message belongs to
   */
  async completeMessage(messageId: string, queueId: string): Promise<void> {
    const shardId = this.masterQueue.getShardForQueue(queueId);
    const inflightDataKey = this.keys.inflightDataKey(shardId);

    // Get stored message for concurrency release
    const dataJson = await this.redis.hget(inflightDataKey, messageId);
    let storedMessage: StoredMessage<z.infer<TPayloadSchema>> | null = null;
    if (dataJson) {
      try {
        storedMessage = JSON.parse(dataJson);
      } catch {
        // Ignore parse error, proceed with completion
      }
    }

    const descriptor: QueueDescriptor = storedMessage
      ? this.queueDescriptorCache.get(queueId) ?? {
          id: queueId,
          tenantId: storedMessage.tenantId,
          metadata: storedMessage.metadata ?? {},
        }
      : { id: queueId, tenantId: this.keys.extractTenantId(queueId), metadata: {} };

    // Complete in visibility manager
    await this.visibilityManager.complete(messageId, queueId);

    // Release concurrency
    if (this.concurrencyManager && storedMessage) {
      await this.concurrencyManager.release(descriptor, messageId);
    }

    // Update both old and new indexes, clean up caches if queue is empty
    const { queueEmpty } = await this.#updateAllIndexesAfterDequeue(
      queueId,
      descriptor.tenantId
    );
    if (queueEmpty) {
      this.queueDescriptorCache.delete(queueId);
      this.queueCooloffStates.delete(queueId);
    }

    this.telemetry.recordComplete();

    this.logger.debug("Message completed", {
      messageId,
      queueId,
    });
  }

  /**
   * Release a message back to the queue for processing by another consumer.
   * The message is placed at the back of the queue.
   *
   * @param messageId - The ID of the message
   * @param queueId - The queue ID the message belongs to
   */
  async releaseMessage(messageId: string, queueId: string): Promise<void> {
    const shardId = this.masterQueue.getShardForQueue(queueId);
    const queueKey = this.keys.queueKey(queueId);
    const queueItemsKey = this.keys.queueItemsKey(queueId);
    const inflightDataKey = this.keys.inflightDataKey(shardId);

    // Get stored message for concurrency release
    const dataJson = await this.redis.hget(inflightDataKey, messageId);
    let storedMessage: StoredMessage<z.infer<TPayloadSchema>> | null = null;
    if (dataJson) {
      try {
        storedMessage = JSON.parse(dataJson);
      } catch {
        // Ignore parse error
      }
    }

    const descriptor: QueueDescriptor = storedMessage
      ? this.queueDescriptorCache.get(queueId) ?? {
          id: queueId,
          tenantId: storedMessage.tenantId,
          metadata: storedMessage.metadata ?? {},
        }
      : { id: queueId, tenantId: this.keys.extractTenantId(queueId), metadata: {} };

    // Release back to queue (visibility manager updates dispatch indexes atomically)
    // Dispatch shard is tenant-based, not queue-based
    const dispatchShardId = this.tenantDispatch.getShardForTenant(descriptor.tenantId);
    const tenantQueueIndexKey = this.keys.tenantQueueIndexKey(descriptor.tenantId);
    const dispatchKey = this.keys.dispatchKey(dispatchShardId);
    await this.visibilityManager.release(
      messageId,
      queueId,
      queueKey,
      queueItemsKey,
      tenantQueueIndexKey,
      dispatchKey,
      descriptor.tenantId,
      Date.now() // Put at back of queue
    );

    // Release concurrency
    if (this.concurrencyManager && storedMessage) {
      await this.concurrencyManager.release(descriptor, messageId);
    }

    this.logger.debug("Message released", {
      messageId,
      queueId,
    });
  }

  /**
   * Mark a message as failed. This will trigger retry logic if configured,
   * or move the message to the dead letter queue.
   *
   * @param messageId - The ID of the message
   * @param queueId - The queue ID the message belongs to
   * @param error - Optional error that caused the failure
   */
  async failMessage(messageId: string, queueId: string, error?: Error): Promise<void> {
    const shardId = this.masterQueue.getShardForQueue(queueId);
    const queueKey = this.keys.queueKey(queueId);
    const queueItemsKey = this.keys.queueItemsKey(queueId);
    const inflightDataKey = this.keys.inflightDataKey(shardId);

    // Get stored message
    const dataJson = await this.redis.hget(inflightDataKey, messageId);
    if (!dataJson) {
      this.logger.error("Cannot fail message: not found in in-flight data", { messageId, queueId });
      return;
    }

    let storedMessage: StoredMessage<z.infer<TPayloadSchema>>;
    try {
      storedMessage = JSON.parse(dataJson);
    } catch {
      this.logger.error("Cannot fail message: failed to parse stored message", {
        messageId,
        queueId,
      });
      return;
    }

    const descriptor = this.queueDescriptorCache.get(queueId) ?? {
      id: queueId,
      tenantId: storedMessage.tenantId,
      metadata: storedMessage.metadata ?? {},
    };

    const dispatchShardId = this.tenantDispatch.getShardForTenant(descriptor.tenantId);
    await this.#handleMessageFailure(
      storedMessage,
      queueId,
      queueKey,
      queueItemsKey,
      dispatchShardId,
      descriptor,
      error
    );
  }

  // ============================================================================
  // Private - Message Processing Helpers
  // ============================================================================

  async #handleMessageFailure(
    storedMessage: StoredMessage<z.infer<TPayloadSchema>>,
    queueId: string,
    queueKey: string,
    queueItemsKey: string,
    dispatchShardId: number,
    descriptor: QueueDescriptor,
    error?: Error
  ): Promise<void> {
    this.telemetry.recordFailure();

    // Check retry strategy
    if (this.retryStrategy) {
      const nextDelay = this.retryStrategy.getNextDelay(storedMessage.attempt, error);

      if (nextDelay !== null) {
        // Retry with incremented attempt
        const updatedMessage = {
          ...storedMessage,
          attempt: storedMessage.attempt + 1,
        };

        // Release with delay, passing the updated message data so the Lua script
        // atomically writes the incremented attempt count when re-queuing.
        const tenantQueueIndexKey = this.keys.tenantQueueIndexKey(descriptor.tenantId);
        const dispatchKey = this.keys.dispatchKey(dispatchShardId);
        await this.visibilityManager.release(
          storedMessage.id,
          queueId,
          queueKey,
          queueItemsKey,
          tenantQueueIndexKey,
          dispatchKey,
          descriptor.tenantId,
          Date.now() + nextDelay,
          JSON.stringify(updatedMessage)
        );

        // Release concurrency
        if (this.concurrencyManager) {
          await this.concurrencyManager.release(descriptor, storedMessage.id);
        }

        this.telemetry.recordRetry();

        this.logger.debug("Message scheduled for retry", {
          messageId: storedMessage.id,
          queueId,
          attempt: storedMessage.attempt + 1,
          delayMs: nextDelay,
        });

        return;
      }
    }

    // Move to DLQ
    await this.#moveToDeadLetterQueue(storedMessage, error?.message);

    // Release concurrency
    if (this.concurrencyManager) {
      await this.concurrencyManager.release(descriptor, storedMessage.id);
    }
  }

  async #moveToDeadLetterQueue(
    storedMessage: StoredMessage<z.infer<TPayloadSchema>>,
    errorMessage?: string
  ): Promise<void> {
    if (!this.deadLetterQueueEnabled) {
      // Just complete and discard
      await this.visibilityManager.complete(storedMessage.id, storedMessage.queueId);
      return;
    }

    const dlqKey = this.keys.deadLetterQueueKey(storedMessage.tenantId);
    const dlqDataKey = this.keys.deadLetterQueueDataKey(storedMessage.tenantId);
    const shardId = this.masterQueue.getShardForQueue(storedMessage.queueId);

    const dlqMessage: DeadLetterMessage<z.infer<TPayloadSchema>> = {
      id: storedMessage.id,
      queueId: storedMessage.queueId,
      tenantId: storedMessage.tenantId,
      payload: storedMessage.payload,
      deadLetteredAt: Date.now(),
      attempts: storedMessage.attempt,
      lastError: errorMessage,
      originalTimestamp: storedMessage.timestamp,
    };

    // Complete in visibility manager
    await this.visibilityManager.complete(storedMessage.id, storedMessage.queueId);

    // Add to DLQ
    const pipeline = this.redis.pipeline();
    pipeline.zadd(dlqKey, dlqMessage.deadLetteredAt, storedMessage.id);
    pipeline.hset(dlqDataKey, storedMessage.id, JSON.stringify(dlqMessage));
    await pipeline.exec();

    this.telemetry.recordDLQ();

    this.logger.info("Message moved to DLQ", {
      messageId: storedMessage.id,
      queueId: storedMessage.queueId,
      tenantId: storedMessage.tenantId,
      attempts: storedMessage.attempt,
      error: errorMessage,
    });
  }

  // ============================================================================
  // Private - Reclaim Loop
  // ============================================================================

  async #runReclaimLoop(): Promise<void> {
    try {
      for await (const _ of setInterval(this.reclaimIntervalMs, null, {
        signal: this.abortController.signal,
      })) {
        try {
          await this.#reclaimTimedOutMessages();
        } catch (error) {
          this.logger.error("Reclaim loop error", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        this.logger.debug("Reclaim loop aborted");
        return;
      }
      throw error;
    }
  }

  async #reclaimTimedOutMessages(): Promise<void> {
    let totalReclaimed = 0;

    for (let shardId = 0; shardId < this.shardCount; shardId++) {
      const reclaimedMessages = await this.visibilityManager.reclaimTimedOut(shardId, (queueId) => {
        const tenantId = this.keys.extractTenantId(queueId);
        const dispatchShardId = this.tenantDispatch.getShardForTenant(tenantId);
        return {
          queueKey: this.keys.queueKey(queueId),
          queueItemsKey: this.keys.queueItemsKey(queueId),
          tenantQueueIndexKey: this.keys.tenantQueueIndexKey(tenantId),
          dispatchKey: this.keys.dispatchKey(dispatchShardId),
          tenantId,
        };
      });

      if (reclaimedMessages.length > 0) {
        // Release concurrency for all reclaimed messages in a single batch
        // This is critical: when a message times out, its concurrency slot must be freed
        // so the message can be processed again when it's re-claimed from the queue
        if (this.concurrencyManager) {
          try {
            await this.concurrencyManager.releaseBatch(
              reclaimedMessages.map((msg) => ({
                queue: {
                  id: msg.queueId,
                  tenantId: msg.tenantId,
                  metadata: msg.metadata ?? {},
                },
                messageId: msg.messageId,
              }))
            );
          } catch (error) {
            this.logger.error("Failed to release concurrency for reclaimed messages", {
              count: reclaimedMessages.length,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Dispatch indexes are updated atomically by the releaseMessage Lua script
        // inside reclaimTimedOut, so no separate index update needed here.
      }

      totalReclaimed += reclaimedMessages.length;
    }

    if (totalReclaimed > 0) {
      this.logger.info("Reclaimed timed-out messages", { count: totalReclaimed });
    }
  }

  // ============================================================================
  // Private - Cooloff State
  // ============================================================================

  #isInCooloff(queueId: string): boolean {
    const state = this.queueCooloffStates.get(queueId);
    if (!state) return false;

    if (state.tag === "cooloff") {
      if (Date.now() >= state.expiresAt) {
        this.queueCooloffStates.delete(queueId);
        return false;
      }
      return true;
    }

    return false;
  }

  #incrementCooloff(queueId: string): void {
    // Safety check: if the cache is too large, just clear it
    if (this.queueCooloffStates.size >= this.maxCooloffStatesSize) {
      this.logger.warn("Cooloff states cache hit size cap, clearing all entries", {
        size: this.queueCooloffStates.size,
        cap: this.maxCooloffStatesSize,
      });
      this.queueCooloffStates.clear();
    }

    const state = this.queueCooloffStates.get(queueId) ?? {
      tag: "normal" as const,
      consecutiveFailures: 0,
    };

    if (state.tag === "normal") {
      const newFailures = state.consecutiveFailures + 1;
      if (newFailures >= this.cooloffThreshold) {
        this.queueCooloffStates.set(queueId, {
          tag: "cooloff",
          expiresAt: Date.now() + this.cooloffPeriodMs,
        });
        this.logger.debug("Queue entered cooloff", {
          queueId,
          cooloffPeriodMs: this.cooloffPeriodMs,
          consecutiveFailures: newFailures,
        });
      } else {
        this.queueCooloffStates.set(queueId, {
          tag: "normal",
          consecutiveFailures: newFailures,
        });
      }
    }
  }

  #resetCooloff(queueId: string): void {
    this.queueCooloffStates.delete(queueId);
  }

  // ============================================================================
  // Private - Helpers
  // ============================================================================

  /**
   * Update both old master queue and new dispatch indexes after a dequeue/complete.
   * Both calls are idempotent - ZREM on a non-existent member is a no-op.
   * This handles the transition period where queues may exist in either or both indexes.
   */
  async #updateAllIndexesAfterDequeue(
    queueId: string,
    tenantId: string
  ): Promise<{ queueEmpty: boolean }> {
    const queueShardId = this.masterQueue.getShardForQueue(queueId);
    const dispatchShardId = this.tenantDispatch.getShardForTenant(tenantId);
    const queueKey = this.keys.queueKey(queueId);
    const masterQueueKey = this.keys.masterQueueKey(queueShardId);
    const tenantQueueIndexKey = this.keys.tenantQueueIndexKey(tenantId);
    const dispatchKey = this.keys.dispatchKey(dispatchShardId);

    // Update legacy master queue (drain path, no-op if queue not there)
    const removedFromMaster = await this.redis.updateMasterQueueIfEmpty(
      masterQueueKey,
      queueKey,
      queueId
    );

    // Update new dispatch indexes
    const removedFromDispatch = await this.redis.updateDispatchIndexes(
      queueKey,
      tenantQueueIndexKey,
      dispatchKey,
      queueId,
      tenantId
    );

    return { queueEmpty: removedFromMaster === 1 || removedFromDispatch === 1 };
  }

  #createSchedulerContext(): SchedulerContext {
    return {
      getCurrentConcurrency: async (groupName, groupId) => {
        if (!this.concurrencyManager) return 0;
        return this.concurrencyManager.getCurrentConcurrency(groupName, groupId);
      },
      getConcurrencyLimit: async (groupName, groupId) => {
        if (!this.concurrencyManager) return Infinity;
        return this.concurrencyManager.getConcurrencyLimit(groupName, groupId);
      },
      isAtCapacity: async (groupName, groupId) => {
        if (!this.concurrencyManager) return false;
        return this.concurrencyManager.isAtCapacity(groupName, groupId);
      },
      getQueueDescriptor: (queueId) => {
        return (
          this.queueDescriptorCache.get(queueId) ?? {
            id: queueId,
            tenantId: this.keys.extractTenantId(queueId),
            metadata: {},
          }
        );
      },
    };
  }

  // ============================================================================
  // Private - Redis Commands
  // ============================================================================

  #registerCommands(): void {
    // ---- Legacy Lua scripts (kept for drain of old master queue) ----

    // Atomic single message enqueue with master queue update (legacy, used for drain only)
    this.redis.defineCommand("enqueueMessageAtomic", {
      numberOfKeys: 3,
      lua: `
local queueKey = KEYS[1]
local queueItemsKey = KEYS[2]
local masterQueueKey = KEYS[3]

local queueId = ARGV[1]
local messageId = ARGV[2]
local timestamp = tonumber(ARGV[3])
local payload = ARGV[4]

redis.call('ZADD', queueKey, timestamp, messageId)
redis.call('HSET', queueItemsKey, messageId, payload)

local oldest = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #oldest >= 2 then
  redis.call('ZADD', masterQueueKey, oldest[2], queueId)
end

return 1
      `,
    });

    // Atomic batch message enqueue with master queue update (legacy, used for drain only)
    this.redis.defineCommand("enqueueBatchAtomic", {
      numberOfKeys: 3,
      lua: `
local queueKey = KEYS[1]
local queueItemsKey = KEYS[2]
local masterQueueKey = KEYS[3]

local queueId = ARGV[1]

for i = 2, #ARGV, 3 do
  local messageId = ARGV[i]
  local timestamp = tonumber(ARGV[i + 1])
  local payload = ARGV[i + 2]
  redis.call('ZADD', queueKey, timestamp, messageId)
  redis.call('HSET', queueItemsKey, messageId, payload)
end

local oldest = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #oldest >= 2 then
  redis.call('ZADD', masterQueueKey, oldest[2], queueId)
end

return (#ARGV - 1) / 3
      `,
    });

    // Remove queue from legacy master queue if empty (drain-only, never re-adds)
    this.redis.defineCommand("updateMasterQueueIfEmpty", {
      numberOfKeys: 2,
      lua: `
local masterQueueKey = KEYS[1]
local queueKey = KEYS[2]
local queueId = ARGV[1]

local count = redis.call('ZCARD', queueKey)
if count == 0 then
  redis.call('ZREM', masterQueueKey, queueId)
  return 1
end

-- Queue still has messages but don't re-add to legacy master queue.
-- New enqueues go through the V2 dispatch path, so we only drain here.
-- Just remove it so it doesn't linger.
redis.call('ZREM', masterQueueKey, queueId)
return 0
      `,
    });

    // ---- New V2 Lua scripts (two-level tenant dispatch) ----

    // Atomic single message enqueue with tenant dispatch index update
    this.redis.defineCommand("enqueueMessageAtomicV2", {
      numberOfKeys: 4,
      lua: `
local queueKey = KEYS[1]
local queueItemsKey = KEYS[2]
local tenantQueueIndexKey = KEYS[3]
local dispatchKey = KEYS[4]

local queueId = ARGV[1]
local messageId = ARGV[2]
local timestamp = tonumber(ARGV[3])
local payload = ARGV[4]
local tenantId = ARGV[5]

-- Add to per-queue storage (same as before)
redis.call('ZADD', queueKey, timestamp, messageId)
redis.call('HSET', queueItemsKey, messageId, payload)

-- Update tenant queue index (Level 2) with queue's oldest message
local oldest = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #oldest >= 2 then
  redis.call('ZADD', tenantQueueIndexKey, oldest[2], queueId)
end

-- Update dispatch index (Level 1) with tenant's oldest across all queues
local tenantOldest = redis.call('ZRANGE', tenantQueueIndexKey, 0, 0, 'WITHSCORES')
if #tenantOldest >= 2 then
  redis.call('ZADD', dispatchKey, tenantOldest[2], tenantId)
end

return 1
      `,
    });

    // Atomic batch message enqueue with tenant dispatch index update
    this.redis.defineCommand("enqueueBatchAtomicV2", {
      numberOfKeys: 4,
      lua: `
local queueKey = KEYS[1]
local queueItemsKey = KEYS[2]
local tenantQueueIndexKey = KEYS[3]
local dispatchKey = KEYS[4]

local queueId = ARGV[1]
local tenantId = ARGV[2]

-- Args after queueId and tenantId are triples: [messageId, timestamp, payload, ...]
for i = 3, #ARGV, 3 do
  local messageId = ARGV[i]
  local timestamp = tonumber(ARGV[i + 1])
  local payload = ARGV[i + 2]
  redis.call('ZADD', queueKey, timestamp, messageId)
  redis.call('HSET', queueItemsKey, messageId, payload)
end

-- Update tenant queue index (Level 2)
local oldest = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #oldest >= 2 then
  redis.call('ZADD', tenantQueueIndexKey, oldest[2], queueId)
end

-- Update dispatch index (Level 1)
local tenantOldest = redis.call('ZRANGE', tenantQueueIndexKey, 0, 0, 'WITHSCORES')
if #tenantOldest >= 2 then
  redis.call('ZADD', dispatchKey, tenantOldest[2], tenantId)
end

return (#ARGV - 2) / 3
      `,
    });

    // Update tenant dispatch indexes after dequeue/complete
    // Handles both queue-empty (remove from indexes) and queue-has-messages (update scores)
    this.redis.defineCommand("updateDispatchIndexes", {
      numberOfKeys: 3,
      lua: `
local queueKey = KEYS[1]
local tenantQueueIndexKey = KEYS[2]
local dispatchKey = KEYS[3]
local queueId = ARGV[1]
local tenantId = ARGV[2]

local count = redis.call('ZCARD', queueKey)
if count == 0 then
  -- Queue is empty: remove from tenant queue index
  redis.call('ZREM', tenantQueueIndexKey, queueId)

  -- Check if tenant has any queues left
  local tenantQueueCount = redis.call('ZCARD', tenantQueueIndexKey)
  if tenantQueueCount == 0 then
    -- No more queues: remove tenant from dispatch
    redis.call('ZREM', dispatchKey, tenantId)
  else
    -- Update dispatch score to tenant's new oldest
    local tenantOldest = redis.call('ZRANGE', tenantQueueIndexKey, 0, 0, 'WITHSCORES')
    if #tenantOldest >= 2 then
      redis.call('ZADD', dispatchKey, tenantOldest[2], tenantId)
    end
  end
  return 1
else
  -- Queue still has messages: update scores
  local oldest = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
  if #oldest >= 2 then
    redis.call('ZADD', tenantQueueIndexKey, oldest[2], queueId)
  end
  local tenantOldest = redis.call('ZRANGE', tenantQueueIndexKey, 0, 0, 'WITHSCORES')
  if #tenantOldest >= 2 then
    redis.call('ZADD', dispatchKey, tenantOldest[2], tenantId)
  end
  return 0
end
      `,
    });

    // Register worker queue commands if enabled
    if (this.workerQueueManager) {
      this.workerQueueManager.registerCommands(this.redis);
    }
  }
}

// Extend Redis interface for custom commands
declare module "@internal/redis" {
  interface RedisCommander<Context> {
    // Legacy commands (kept for drain of old master queue)
    enqueueMessageAtomic(
      queueKey: string,
      queueItemsKey: string,
      masterQueueKey: string,
      queueId: string,
      messageId: string,
      timestamp: string,
      payload: string
    ): Promise<number>;

    enqueueBatchAtomic(
      queueKey: string,
      queueItemsKey: string,
      masterQueueKey: string,
      queueId: string,
      ...args: string[]
    ): Promise<number>;

    updateMasterQueueIfEmpty(
      masterQueueKey: string,
      queueKey: string,
      queueId: string
    ): Promise<number>;

    // V2 commands (two-level tenant dispatch)
    enqueueMessageAtomicV2(
      queueKey: string,
      queueItemsKey: string,
      tenantQueueIndexKey: string,
      dispatchKey: string,
      queueId: string,
      messageId: string,
      timestamp: string,
      payload: string,
      tenantId: string
    ): Promise<number>;

    enqueueBatchAtomicV2(
      queueKey: string,
      queueItemsKey: string,
      tenantQueueIndexKey: string,
      dispatchKey: string,
      queueId: string,
      tenantId: string,
      ...args: string[]
    ): Promise<number>;

    updateDispatchIndexes(
      queueKey: string,
      tenantQueueIndexKey: string,
      dispatchKey: string,
      queueId: string,
      tenantId: string
    ): Promise<number>;
  }
}
