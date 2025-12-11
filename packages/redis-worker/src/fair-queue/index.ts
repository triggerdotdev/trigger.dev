import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { SpanKind } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { nanoid } from "nanoid";
import { setInterval } from "node:timers/promises";
import { type z } from "zod";
import { ConcurrencyManager } from "./concurrency.js";
import { MasterQueue } from "./masterQueue.js";
import { type RetryStrategy, ExponentialBackoffRetry } from "./retry.js";
import { FairQueueTelemetry, FairQueueAttributes, MessagingAttributes } from "./telemetry.js";
import type {
  ConcurrencyGroupConfig,
  DeadLetterMessage,
  EnqueueBatchOptions,
  EnqueueOptions,
  FairQueueKeyProducer,
  FairQueueOptions,
  FairScheduler,
  GlobalRateLimiter,
  MessageHandler,
  MessageHandlerContext,
  QueueCooloffState,
  QueueDescriptor,
  QueueMessage,
  SchedulerContext,
  StoredMessage,
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

/**
 * FairQueue is the main orchestrator for fair queue processing.
 *
 * It coordinates:
 * - Master queue with sharding (using jump consistent hash)
 * - Fair scheduling via pluggable schedulers
 * - Multi-level concurrency limiting
 * - Visibility timeouts with heartbeats
 * - Worker queues with blocking pop
 * - Retry strategies with dead letter queue
 * - OpenTelemetry tracing and metrics
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
  private workerQueueManager?: WorkerQueueManager;
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
  private workerQueueEnabled: boolean;
  private workerQueueBlockingTimeoutSeconds: number;
  private workerQueueResolver?: (message: StoredMessage<z.infer<TPayloadSchema>>) => string;

  // Cooloff state
  private cooloffEnabled: boolean;
  private cooloffThreshold: number;
  private cooloffPeriodMs: number;
  private queueCooloffStates = new Map<string, QueueCooloffState>();

  // Global rate limiter
  private globalRateLimiter?: GlobalRateLimiter;

  // Runtime state
  private messageHandler?: MessageHandler<z.infer<TPayloadSchema>>;
  private isRunning = false;
  private abortController: AbortController;
  private masterQueueConsumerLoops: Promise<void>[] = [];
  private workerQueueConsumerLoops: Promise<void>[] = [];
  private reclaimLoop?: Promise<void>;

  // Queue descriptor cache for message processing
  private queueDescriptorCache = new Map<string, QueueDescriptor>();

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

    // Worker queue
    this.workerQueueEnabled = options.workerQueue?.enabled ?? false;
    this.workerQueueBlockingTimeoutSeconds = options.workerQueue?.blockingTimeoutSeconds ?? 10;
    this.workerQueueResolver = options.workerQueue?.resolveWorkerQueue;

    // Cooloff
    this.cooloffEnabled = options.cooloff?.enabled ?? true;
    this.cooloffThreshold = options.cooloff?.threshold ?? 10;
    this.cooloffPeriodMs = options.cooloff?.periodMs ?? 10_000;

    // Global rate limiter
    this.globalRateLimiter = options.globalRateLimiter;

    // Initialize telemetry
    this.telemetry = new FairQueueTelemetry({
      tracer: options.tracer,
      meter: options.meter,
      name: options.name ?? "fairqueue",
    });

    // Initialize components
    this.masterQueue = new MasterQueue({
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

    if (this.workerQueueEnabled) {
      this.workerQueueManager = new WorkerQueueManager({
        redis: options.redis,
        keys: options.keys,
        logger: {
          debug: (msg, ctx) => this.logger.debug(msg, ctx),
          error: (msg, ctx) => this.logger.error(msg, ctx),
        },
      });
    }

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
  // Public API - Message Handler
  // ============================================================================

  /**
   * Set the message handler for processing dequeued messages.
   */
  onMessage(handler: MessageHandler<z.infer<TPayloadSchema>>): void {
    this.messageHandler = handler;
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
        const shardId = this.masterQueue.getShardForQueue(options.queueId);
        const masterQueueKey = this.keys.masterQueueKey(shardId);

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
            : options.queueId,
          metadata: options.metadata,
        };

        // Use atomic Lua script to enqueue and update master queue
        await this.redis.enqueueMessageAtomic(
          queueKey,
          queueItemsKey,
          masterQueueKey,
          options.queueId,
          messageId,
          timestamp.toString(),
          JSON.stringify(storedMessage)
        );

        span.setAttributes({
          [FairQueueAttributes.QUEUE_ID]: options.queueId,
          [FairQueueAttributes.TENANT_ID]: options.tenantId,
          [FairQueueAttributes.MESSAGE_ID]: messageId,
          [FairQueueAttributes.SHARD_ID]: shardId.toString(),
        });

        this.telemetry.recordEnqueue(
          this.telemetry.messageAttributes({
            queueId: options.queueId,
            tenantId: options.tenantId,
            messageId,
          })
        );

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
        const shardId = this.masterQueue.getShardForQueue(options.queueId);
        const masterQueueKey = this.keys.masterQueueKey(shardId);
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
              : options.queueId,
            metadata: options.metadata,
          };

          messageIds.push(messageId);
          args.push(messageId, timestamp.toString(), JSON.stringify(storedMessage));
        }

        // Use atomic Lua script for batch enqueue
        await this.redis.enqueueBatchAtomic(
          queueKey,
          queueItemsKey,
          masterQueueKey,
          options.queueId,
          ...args
        );

        span.setAttributes({
          [FairQueueAttributes.QUEUE_ID]: options.queueId,
          [FairQueueAttributes.TENANT_ID]: options.tenantId,
          [FairQueueAttributes.MESSAGE_COUNT]: messageIds.length,
          [FairQueueAttributes.SHARD_ID]: shardId.toString(),
        });

        this.telemetry.recordEnqueueBatch(
          messageIds.length,
          this.telemetry.messageAttributes({
            queueId: options.queueId,
            tenantId: options.tenantId,
          })
        );

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

  // ============================================================================
  // Public API - Lifecycle
  // ============================================================================

  /**
   * Start the consumer loops and reclaim loop.
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.abortController = new AbortController();

    if (this.workerQueueEnabled && this.workerQueueManager) {
      // Two-stage processing: master queue consumers push to worker queues
      // Start master queue consumers (one per shard)
      for (let shardId = 0; shardId < this.shardCount; shardId++) {
        const loop = this.#runMasterQueueConsumerLoop(shardId);
        this.masterQueueConsumerLoops.push(loop);
      }

      // Start worker queue consumers (multiple per consumer count)
      for (let consumerId = 0; consumerId < this.consumerCount; consumerId++) {
        const loop = this.#runWorkerQueueConsumerLoop(consumerId);
        this.workerQueueConsumerLoops.push(loop);
      }
    } else {
      // Direct processing: consumers process from message queues directly
      for (let consumerId = 0; consumerId < this.consumerCount; consumerId++) {
        for (let shardId = 0; shardId < this.shardCount; shardId++) {
          const loop = this.#runDirectConsumerLoop(consumerId, shardId);
          this.masterQueueConsumerLoops.push(loop);
        }
      }
    }

    // Start reclaim loop
    this.reclaimLoop = this.#runReclaimLoop();

    this.logger.info("FairQueue started", {
      consumerCount: this.consumerCount,
      shardCount: this.shardCount,
      workerQueueEnabled: this.workerQueueEnabled,
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

    await Promise.allSettled([
      ...this.masterQueueConsumerLoops,
      ...this.workerQueueConsumerLoops,
      this.reclaimLoop,
    ]);

    this.masterQueueConsumerLoops = [];
    this.workerQueueConsumerLoops = [];
    this.reclaimLoop = undefined;

    this.logger.info("FairQueue stopped");
  }

  /**
   * Close all resources.
   */
  async close(): Promise<void> {
    await this.stop();
    await Promise.all([
      this.masterQueue.close(),
      this.concurrencyManager?.close(),
      this.visibilityManager.close(),
      this.workerQueueManager?.close(),
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
   * Get total queue count across all shards.
   */
  async getTotalQueueCount(): Promise<number> {
    return await this.masterQueue.getTotalQueueCount();
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

    try {
      for await (const _ of setInterval(this.consumerIntervalMs, null, {
        signal: this.abortController.signal,
      })) {
        try {
          await this.#processMasterQueueShard(loopId, shardId);
        } catch (error) {
          this.logger.error("Master queue consumer error", {
            loopId,
            shardId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.logger.debug("Master queue consumer aborted", { loopId });
        return;
      }
      throw error;
    }
  }

  async #processMasterQueueShard(loopId: string, shardId: number): Promise<void> {
    const masterQueueKey = this.keys.masterQueueKey(shardId);

    // Create scheduler context
    const context = this.#createSchedulerContext();

    // Get queues to process from scheduler
    const tenantQueues = await this.scheduler.selectQueues(masterQueueKey, loopId, context);

    if (tenantQueues.length === 0) {
      return;
    }

    // Process queues and push to worker queues
    for (const { tenantId, queues } of tenantQueues) {
      for (const queueId of queues) {
        // Check cooloff
        if (this.cooloffEnabled && this.#isInCooloff(queueId)) {
          continue;
        }

        const processed = await this.#claimAndPushToWorkerQueue(loopId, queueId, tenantId, shardId);

        if (processed) {
          await this.scheduler.recordProcessed?.(tenantId, queueId);
          this.#resetCooloff(queueId);
        } else {
          this.#incrementCooloff(queueId);
        }
      }
    }
  }

  async #claimAndPushToWorkerQueue(
    loopId: string,
    queueId: string,
    tenantId: string,
    shardId: number
  ): Promise<boolean> {
    const queueKey = this.keys.queueKey(queueId);
    const queueItemsKey = this.keys.queueItemsKey(queueId);
    const masterQueueKey = this.keys.masterQueueKey(shardId);
    const descriptor = this.queueDescriptorCache.get(queueId) ?? {
      id: queueId,
      tenantId,
      metadata: {},
    };

    // Check concurrency before claiming
    if (this.concurrencyManager) {
      const check = await this.concurrencyManager.canProcess(descriptor);
      if (!check.allowed) {
        return false;
      }
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

    // Claim message with visibility timeout
    const claimResult = await this.visibilityManager.claim<StoredMessage<z.infer<TPayloadSchema>>>(
      queueId,
      queueKey,
      queueItemsKey,
      loopId,
      this.visibilityTimeoutMs
    );

    if (!claimResult.claimed || !claimResult.message) {
      // Queue is empty, update master queue
      await this.redis.updateMasterQueueIfEmpty(masterQueueKey, queueKey, queueId);
      return false;
    }

    const { message } = claimResult;

    // Reserve concurrency slot
    if (this.concurrencyManager) {
      const reserved = await this.concurrencyManager.reserve(descriptor, message.messageId);
      if (!reserved) {
        // Release message back to queue
        await this.visibilityManager.release(message.messageId, queueId, queueKey, queueItemsKey);
        return false;
      }
    }

    // Determine worker queue
    const workerQueueId = message.payload.workerQueue ?? queueId;

    // Push to worker queue
    const messageKey = `${message.messageId}:${queueId}`;
    await this.workerQueueManager!.push(workerQueueId, messageKey);

    return true;
  }

  // ============================================================================
  // Private - Worker Queue Consumer Loop (Two-Stage)
  // ============================================================================

  async #runWorkerQueueConsumerLoop(consumerId: number): Promise<void> {
    const loopId = `worker-${consumerId}`;
    const workerQueueId = loopId; // Each consumer has its own worker queue by default

    try {
      while (this.isRunning) {
        if (!this.messageHandler) {
          await new Promise((resolve) => setTimeout(resolve, this.consumerIntervalMs));
          continue;
        }

        try {
          // Blocking pop from worker queue
          const messageKey = await this.workerQueueManager!.blockingPop(
            workerQueueId,
            this.workerQueueBlockingTimeoutSeconds,
            this.abortController.signal
          );

          if (!messageKey) {
            continue; // Timeout, loop again
          }

          // Parse message key
          const colonIndex = messageKey.indexOf(":");
          if (colonIndex === -1) {
            this.logger.error("Invalid message key format", { messageKey });
            continue;
          }

          const messageId = messageKey.substring(0, colonIndex);
          const queueId = messageKey.substring(colonIndex + 1);

          await this.#processMessageFromWorkerQueue(loopId, messageId, queueId);
        } catch (error) {
          if (this.abortController.signal.aborted) {
            break;
          }
          this.logger.error("Worker queue consumer error", {
            loopId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.logger.debug("Worker queue consumer aborted", { loopId });
        return;
      }
      throw error;
    }
  }

  async #processMessageFromWorkerQueue(
    loopId: string,
    messageId: string,
    queueId: string
  ): Promise<void> {
    // Get message data from in-flight
    const shardId = this.masterQueue.getShardForQueue(queueId);
    const inflightDataKey = this.keys.inflightDataKey(shardId);
    const dataJson = await this.redis.hget(inflightDataKey, messageId);

    if (!dataJson) {
      this.logger.error("Message not found in in-flight data", { messageId, queueId });
      return;
    }

    let storedMessage: StoredMessage<z.infer<TPayloadSchema>>;
    try {
      storedMessage = JSON.parse(dataJson);
    } catch {
      this.logger.error("Failed to parse message data", { messageId, queueId });
      return;
    }

    await this.#processMessage(loopId, storedMessage, queueId);
  }

  // ============================================================================
  // Private - Direct Consumer Loop (No Worker Queue)
  // ============================================================================

  async #runDirectConsumerLoop(consumerId: number, shardId: number): Promise<void> {
    const loopId = `consumer-${consumerId}-shard-${shardId}`;

    try {
      for await (const _ of setInterval(this.consumerIntervalMs, null, {
        signal: this.abortController.signal,
      })) {
        if (!this.messageHandler) {
          continue;
        }

        try {
          await this.#processDirectIteration(loopId, shardId);
        } catch (error) {
          this.logger.error("Direct consumer iteration error", {
            loopId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        this.logger.debug("Direct consumer loop aborted", { loopId });
        return;
      }
      throw error;
    }
  }

  async #processDirectIteration(loopId: string, shardId: number): Promise<void> {
    const masterQueueKey = this.keys.masterQueueKey(shardId);

    // Create scheduler context
    const context = this.#createSchedulerContext();

    // Get queues to process from scheduler
    const tenantQueues = await this.scheduler.selectQueues(masterQueueKey, loopId, context);

    if (tenantQueues.length === 0) {
      return;
    }

    // Process messages from each selected tenant
    // For fairness, process up to available concurrency slots per tenant
    for (const { tenantId, queues } of tenantQueues) {
      // Get available concurrency for this tenant
      let availableSlots = 1; // Default to 1 for backwards compatibility
      if (this.concurrencyManager) {
        const [current, limit] = await Promise.all([
          this.concurrencyManager.getCurrentConcurrency("tenant", tenantId),
          this.concurrencyManager.getConcurrencyLimit("tenant", tenantId),
        ]);
        availableSlots = Math.max(1, limit - current);
      }

      // Process up to availableSlots messages from this tenant's queues
      let slotsUsed = 0;
      queueLoop: for (const queueId of queues) {
        while (slotsUsed < availableSlots) {
          // Check cooloff
          if (this.cooloffEnabled && this.#isInCooloff(queueId)) {
            break; // Try next queue
          }

          const processed = await this.#processOneMessage(loopId, queueId, tenantId, shardId);

          if (processed) {
            await this.scheduler.recordProcessed?.(tenantId, queueId);
            this.#resetCooloff(queueId);
            slotsUsed++;
          } else {
            this.#incrementCooloff(queueId);
            break; // Queue empty or blocked, try next queue
          }
        }
        if (slotsUsed >= availableSlots) {
          break queueLoop;
        }
      }
    }
  }

  async #processOneMessage(
    loopId: string,
    queueId: string,
    tenantId: string,
    shardId: number
  ): Promise<boolean> {
    const queueKey = this.keys.queueKey(queueId);
    const queueItemsKey = this.keys.queueItemsKey(queueId);
    const masterQueueKey = this.keys.masterQueueKey(shardId);
    const descriptor = this.queueDescriptorCache.get(queueId) ?? {
      id: queueId,
      tenantId,
      metadata: {},
    };

    // Check concurrency before claiming
    if (this.concurrencyManager) {
      const check = await this.concurrencyManager.canProcess(descriptor);
      if (!check.allowed) {
        return false;
      }
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

    // Claim message with visibility timeout
    const claimResult = await this.visibilityManager.claim<StoredMessage<z.infer<TPayloadSchema>>>(
      queueId,
      queueKey,
      queueItemsKey,
      loopId,
      this.visibilityTimeoutMs
    );

    if (!claimResult.claimed || !claimResult.message) {
      // Queue is empty, update master queue
      await this.redis.updateMasterQueueIfEmpty(masterQueueKey, queueKey, queueId);
      return false;
    }

    const { message } = claimResult;

    // Reserve concurrency slot
    if (this.concurrencyManager) {
      const reserved = await this.concurrencyManager.reserve(descriptor, message.messageId);
      if (!reserved) {
        // Release message back to queue
        await this.visibilityManager.release(message.messageId, queueId, queueKey, queueItemsKey);
        return false;
      }
    }

    await this.#processMessage(loopId, message.payload, queueId);
    return true;
  }

  // ============================================================================
  // Private - Message Processing
  // ============================================================================

  async #processMessage(
    loopId: string,
    storedMessage: StoredMessage<z.infer<TPayloadSchema>>,
    queueId: string
  ): Promise<void> {
    const startTime = Date.now();
    const queueKey = this.keys.queueKey(queueId);
    const queueItemsKey = this.keys.queueItemsKey(queueId);
    const shardId = this.masterQueue.getShardForQueue(queueId);
    const masterQueueKey = this.keys.masterQueueKey(shardId);

    const descriptor = this.queueDescriptorCache.get(queueId) ?? {
      id: queueId,
      tenantId: storedMessage.tenantId,
      metadata: storedMessage.metadata ?? {},
    };

    // Parse payload with schema if provided
    let payload: z.infer<TPayloadSchema>;
    if (this.payloadSchema) {
      const result = this.payloadSchema.safeParse(storedMessage.payload);
      if (!result.success) {
        this.logger.error("Payload validation failed on dequeue", {
          messageId: storedMessage.id,
          queueId,
          error: result.error.message,
        });
        // Move to DLQ
        await this.#moveToDeadLetterQueue(storedMessage, "Payload validation failed");
        return;
      }
      payload = result.data;
    } else {
      payload = storedMessage.payload;
    }

    // Build queue message
    const queueMessage: QueueMessage<z.infer<TPayloadSchema>> = {
      id: storedMessage.id,
      queueId,
      payload,
      timestamp: storedMessage.timestamp,
      attempt: storedMessage.attempt,
      metadata: storedMessage.metadata,
    };

    // Record queue time
    const queueTime = startTime - storedMessage.timestamp;
    this.telemetry.recordQueueTime(
      queueTime,
      this.telemetry.messageAttributes({
        queueId,
        tenantId: storedMessage.tenantId,
        messageId: storedMessage.id,
      })
    );

    // Build handler context
    const handlerContext: MessageHandlerContext<z.infer<TPayloadSchema>> = {
      message: queueMessage,
      queue: descriptor,
      consumerId: loopId,
      heartbeat: async () => {
        return this.visibilityManager.heartbeat(
          storedMessage.id,
          queueId,
          this.heartbeatIntervalMs
        );
      },
      complete: async () => {
        await this.#completeMessage(storedMessage, queueId, queueKey, masterQueueKey, descriptor);
        this.telemetry.recordComplete(
          this.telemetry.messageAttributes({
            queueId,
            tenantId: storedMessage.tenantId,
            messageId: storedMessage.id,
          })
        );
        this.telemetry.recordProcessingTime(
          Date.now() - startTime,
          this.telemetry.messageAttributes({
            queueId,
            tenantId: storedMessage.tenantId,
            messageId: storedMessage.id,
          })
        );
      },
      release: async () => {
        await this.#releaseMessage(storedMessage, queueId, queueKey, queueItemsKey, descriptor);
      },
      fail: async (error?: Error) => {
        await this.#handleMessageFailure(
          storedMessage,
          queueId,
          queueKey,
          queueItemsKey,
          masterQueueKey,
          descriptor,
          error
        );
      },
    };

    // Call message handler
    try {
      await this.telemetry.trace(
        "processMessage",
        async (span) => {
          span.setAttributes({
            [FairQueueAttributes.QUEUE_ID]: queueId,
            [FairQueueAttributes.TENANT_ID]: storedMessage.tenantId,
            [FairQueueAttributes.MESSAGE_ID]: storedMessage.id,
            [FairQueueAttributes.ATTEMPT]: storedMessage.attempt,
            [FairQueueAttributes.CONSUMER_ID]: loopId,
          });

          await this.messageHandler!(handlerContext);
        },
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            [MessagingAttributes.OPERATION]: "process",
          },
        }
      );
    } catch (error) {
      this.logger.error("Message handler error", {
        messageId: storedMessage.id,
        queueId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Trigger failure handling
      await handlerContext.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async #completeMessage(
    storedMessage: StoredMessage<z.infer<TPayloadSchema>>,
    queueId: string,
    queueKey: string,
    masterQueueKey: string,
    descriptor: QueueDescriptor
  ): Promise<void> {
    const shardId = this.masterQueue.getShardForQueue(queueId);

    // Complete in visibility manager
    await this.visibilityManager.complete(storedMessage.id, queueId);

    // Release concurrency
    if (this.concurrencyManager) {
      await this.concurrencyManager.release(descriptor, storedMessage.id);
    }

    // Update master queue if queue is now empty
    await this.redis.updateMasterQueueIfEmpty(masterQueueKey, queueKey, queueId);

    this.logger.debug("Message completed", {
      messageId: storedMessage.id,
      queueId,
    });
  }

  async #releaseMessage(
    storedMessage: StoredMessage<z.infer<TPayloadSchema>>,
    queueId: string,
    queueKey: string,
    queueItemsKey: string,
    descriptor: QueueDescriptor
  ): Promise<void> {
    // Release back to queue
    await this.visibilityManager.release(
      storedMessage.id,
      queueId,
      queueKey,
      queueItemsKey,
      Date.now() // Put at back of queue
    );

    // Release concurrency
    if (this.concurrencyManager) {
      await this.concurrencyManager.release(descriptor, storedMessage.id);
    }

    this.logger.debug("Message released", {
      messageId: storedMessage.id,
      queueId,
    });
  }

  async #handleMessageFailure(
    storedMessage: StoredMessage<z.infer<TPayloadSchema>>,
    queueId: string,
    queueKey: string,
    queueItemsKey: string,
    masterQueueKey: string,
    descriptor: QueueDescriptor,
    error?: Error
  ): Promise<void> {
    this.telemetry.recordFailure(
      this.telemetry.messageAttributes({
        queueId,
        tenantId: storedMessage.tenantId,
        messageId: storedMessage.id,
        attempt: storedMessage.attempt,
      })
    );

    // Check retry strategy
    if (this.retryStrategy) {
      const nextDelay = this.retryStrategy.getNextDelay(storedMessage.attempt, error);

      if (nextDelay !== null) {
        // Retry with incremented attempt
        const updatedMessage = {
          ...storedMessage,
          attempt: storedMessage.attempt + 1,
        };

        // Release with delay
        await this.visibilityManager.release(
          storedMessage.id,
          queueId,
          queueKey,
          queueItemsKey,
          Date.now() + nextDelay
        );

        // Update message in items hash with new attempt count
        await this.redis.hset(queueItemsKey, storedMessage.id, JSON.stringify(updatedMessage));

        // Release concurrency
        if (this.concurrencyManager) {
          await this.concurrencyManager.release(descriptor, storedMessage.id);
        }

        this.telemetry.recordRetry(
          this.telemetry.messageAttributes({
            queueId,
            tenantId: storedMessage.tenantId,
            messageId: storedMessage.id,
            attempt: storedMessage.attempt + 1,
          })
        );

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
      const shardId = this.masterQueue.getShardForQueue(storedMessage.queueId);
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

    this.telemetry.recordDLQ(
      this.telemetry.messageAttributes({
        queueId: storedMessage.queueId,
        tenantId: storedMessage.tenantId,
        messageId: storedMessage.id,
        attempt: storedMessage.attempt,
      })
    );

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
      if (error instanceof Error && error.name === "AbortError") {
        this.logger.debug("Reclaim loop aborted");
        return;
      }
      throw error;
    }
  }

  async #reclaimTimedOutMessages(): Promise<void> {
    let totalReclaimed = 0;

    for (let shardId = 0; shardId < this.shardCount; shardId++) {
      const reclaimed = await this.visibilityManager.reclaimTimedOut(shardId, (queueId) => ({
        queueKey: this.keys.queueKey(queueId),
        queueItemsKey: this.keys.queueItemsKey(queueId),
      }));

      totalReclaimed += reclaimed;
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
    // Atomic single message enqueue with master queue update
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

-- Add to sorted set (score = timestamp)
redis.call('ZADD', queueKey, timestamp, messageId)

-- Store payload in hash
redis.call('HSET', queueItemsKey, messageId, payload)

-- Update master queue with oldest message timestamp
local oldest = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #oldest >= 2 then
  redis.call('ZADD', masterQueueKey, oldest[2], queueId)
end

return 1
      `,
    });

    // Atomic batch message enqueue with master queue update
    this.redis.defineCommand("enqueueBatchAtomic", {
      numberOfKeys: 3,
      lua: `
local queueKey = KEYS[1]
local queueItemsKey = KEYS[2]
local masterQueueKey = KEYS[3]

local queueId = ARGV[1]

-- Args after queueId are triples: [messageId, timestamp, payload, ...]
for i = 2, #ARGV, 3 do
  local messageId = ARGV[i]
  local timestamp = tonumber(ARGV[i + 1])
  local payload = ARGV[i + 2]
  
  -- Add to sorted set
  redis.call('ZADD', queueKey, timestamp, messageId)
  
  -- Store payload in hash
  redis.call('HSET', queueItemsKey, messageId, payload)
end

-- Update master queue with oldest message timestamp
local oldest = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #oldest >= 2 then
  redis.call('ZADD', masterQueueKey, oldest[2], queueId)
end

return (#ARGV - 1) / 3
      `,
    });

    // Update master queue if queue is empty
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
else
  -- Update with oldest message timestamp
  local oldest = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
  if #oldest >= 2 then
    redis.call('ZADD', masterQueueKey, oldest[2], queueId)
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
  }
}
