import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import type { BatchItemFailure, BatchMeta, CompleteBatchResult } from "./types.js";

/**
 * Key constants for Redis keys used by completion tracker.
 */
const KEY_PREFIX = "batch";
const META_SUFFIX = "meta";
const RUNS_SUFFIX = "runs";
const FAILURES_SUFFIX = "failures";
const PROCESSED_SUFFIX = "processed";
const PROCESSED_ITEMS_SUFFIX = "processed_items";
const ENQUEUED_ITEMS_SUFFIX = "enqueued_items";

/**
 * BatchCompletionTracker handles batch metadata storage and completion tracking.
 *
 * Responsibilities:
 * - Store and retrieve batch metadata in Redis
 * - Track successful run IDs per batch
 * - Track failures per batch
 * - Atomically increment processed count (with idempotency per item)
 * - Detect batch completion (processedCount === runCount)
 * - Cleanup batch data after completion
 *
 * Idempotency:
 * The tracker uses a set to track which item indices have been processed.
 * This prevents double-counting if a message is redelivered due to visibility timeout.
 */
export class BatchCompletionTracker {
  private redis: Redis;
  private logger: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };

  constructor(options: {
    redis: RedisOptions;
    logger?: {
      debug: (message: string, context?: Record<string, unknown>) => void;
      error: (message: string, context?: Record<string, unknown>) => void;
    };
  }) {
    this.redis = createRedisClient(options.redis);
    this.logger = options.logger ?? {
      debug: () => {},
      error: () => {},
    };

    this.#registerCommands();
  }

  // ============================================================================
  // Key Generation
  // ============================================================================

  private metaKey(batchId: string): string {
    return `${KEY_PREFIX}:${batchId}:${META_SUFFIX}`;
  }

  private runsKey(batchId: string): string {
    return `${KEY_PREFIX}:${batchId}:${RUNS_SUFFIX}`;
  }

  private failuresKey(batchId: string): string {
    return `${KEY_PREFIX}:${batchId}:${FAILURES_SUFFIX}`;
  }

  private processedCountKey(batchId: string): string {
    return `${KEY_PREFIX}:${batchId}:${PROCESSED_SUFFIX}`;
  }

  private processedItemsKey(batchId: string): string {
    return `${KEY_PREFIX}:${batchId}:${PROCESSED_ITEMS_SUFFIX}`;
  }

  private enqueuedItemsKey(batchId: string): string {
    return `${KEY_PREFIX}:${batchId}:${ENQUEUED_ITEMS_SUFFIX}`;
  }

  // ============================================================================
  // Metadata Operations
  // ============================================================================

  /**
   * Store batch metadata in Redis.
   */
  async storeMeta(batchId: string, meta: BatchMeta): Promise<void> {
    const key = this.metaKey(batchId);
    await this.redis.set(key, JSON.stringify(meta));

    this.logger.debug("Stored batch metadata", { batchId, runCount: meta.runCount });
  }

  /**
   * Retrieve batch metadata from Redis.
   */
  async getMeta(batchId: string): Promise<BatchMeta | null> {
    const key = this.metaKey(batchId);
    const metaJson = await this.redis.get(key);

    if (!metaJson) {
      return null;
    }

    return JSON.parse(metaJson) as BatchMeta;
  }

  // ============================================================================
  // Success/Failure Recording (Idempotent)
  // ============================================================================

  /**
   * Record a successful run and increment processed count atomically.
   * This operation is idempotent - if the same itemIndex is processed again,
   * it will not double-count (returns current processed count without incrementing).
   *
   * Returns the new processed count.
   */
  async recordSuccess(batchId: string, runId: string, itemIndex?: number): Promise<number> {
    const processedItemsKey = this.processedItemsKey(batchId);
    const runsKey = this.runsKey(batchId);
    const processedKey = this.processedCountKey(batchId);

    // Use Lua script for atomic idempotent recording
    const result = await this.redis.recordSuccessIdempotent(
      processedItemsKey,
      runsKey,
      processedKey,
      itemIndex !== undefined ? itemIndex.toString() : runId, // Use itemIndex as idempotency key if provided
      runId
    );

    const processedCount = parseInt(result, 10);

    this.logger.debug("Recorded success", { batchId, runId, itemIndex, processedCount });

    return processedCount;
  }

  /**
   * Record a failure and increment processed count atomically.
   * This operation is idempotent - if the same itemIndex is processed again,
   * it will not double-count (returns current processed count without incrementing).
   *
   * Returns the new processed count.
   */
  async recordFailure(
    batchId: string,
    failure: Omit<BatchItemFailure, "timestamp">
  ): Promise<number> {
    const processedItemsKey = this.processedItemsKey(batchId);
    const failuresKey = this.failuresKey(batchId);
    const processedKey = this.processedCountKey(batchId);

    const failureRecord: BatchItemFailure = {
      ...failure,
      timestamp: Date.now(),
    };

    // Use Lua script for atomic idempotent recording
    const result = await this.redis.recordFailureIdempotent(
      processedItemsKey,
      failuresKey,
      processedKey,
      failure.index.toString(), // Use itemIndex as idempotency key
      JSON.stringify(failureRecord)
    );

    const processedCount = parseInt(result, 10);

    this.logger.debug("Recorded failure", {
      batchId,
      index: failure.index,
      error: failure.error,
      processedCount,
    });

    return processedCount;
  }

  // ============================================================================
  // Query Operations
  // ============================================================================

  /**
   * Get all successful run IDs for a batch.
   */
  async getSuccessfulRuns(batchId: string): Promise<string[]> {
    const runsKey = this.runsKey(batchId);
    return await this.redis.lrange(runsKey, 0, -1);
  }

  /**
   * Get all failures for a batch.
   */
  async getFailures(batchId: string): Promise<BatchItemFailure[]> {
    const failuresKey = this.failuresKey(batchId);
    const failureJsons = await this.redis.lrange(failuresKey, 0, -1);
    return failureJsons.map((json) => JSON.parse(json) as BatchItemFailure);
  }

  /**
   * Get the current processed count for a batch.
   */
  async getProcessedCount(batchId: string): Promise<number> {
    const processedKey = this.processedCountKey(batchId);
    const count = await this.redis.get(processedKey);
    return count ? parseInt(count, 10) : 0;
  }

  /**
   * Check if a batch is complete (all items processed).
   */
  async isComplete(batchId: string): Promise<boolean> {
    const meta = await this.getMeta(batchId);
    if (!meta) {
      return false;
    }

    const processedCount = await this.getProcessedCount(batchId);
    return processedCount >= meta.runCount;
  }

  // ============================================================================
  // Enqueue Tracking (for 2-phase batch API)
  // ============================================================================

  /**
   * Check if an item index has already been enqueued.
   * Used for idempotency in the streaming batch items endpoint.
   */
  async isItemEnqueued(batchId: string, itemIndex: number): Promise<boolean> {
    const enqueuedKey = this.enqueuedItemsKey(batchId);
    const result = await this.redis.sismember(enqueuedKey, itemIndex.toString());
    return result === 1;
  }

  /**
   * Mark an item index as enqueued atomically.
   * Returns true if the item was newly added (not a duplicate).
   * Returns false if the item was already enqueued (deduplicated).
   */
  async markItemEnqueued(batchId: string, itemIndex: number): Promise<boolean> {
    const enqueuedKey = this.enqueuedItemsKey(batchId);
    const added = await this.redis.sadd(enqueuedKey, itemIndex.toString());
    return added === 1;
  }

  /**
   * Get the count of enqueued items for a batch.
   */
  async getEnqueuedCount(batchId: string): Promise<number> {
    const enqueuedKey = this.enqueuedItemsKey(batchId);
    return await this.redis.scard(enqueuedKey);
  }

  // ============================================================================
  // Completion Operations
  // ============================================================================

  /**
   * Get the complete result for a finished batch.
   * Gathers all run IDs and failures.
   */
  async getCompletionResult(batchId: string): Promise<CompleteBatchResult> {
    const [runIds, failures] = await Promise.all([
      this.getSuccessfulRuns(batchId),
      this.getFailures(batchId),
    ]);

    return {
      batchId,
      runIds,
      successfulRunCount: runIds.length,
      failedRunCount: failures.length,
      failures,
    };
  }

  /**
   * Clean up all Redis keys for a completed batch.
   */
  async cleanup(batchId: string): Promise<void> {
    const keys = [
      this.metaKey(batchId),
      this.runsKey(batchId),
      this.failuresKey(batchId),
      this.processedCountKey(batchId),
      this.processedItemsKey(batchId),
      this.enqueuedItemsKey(batchId),
    ];

    await this.redis.del(...keys);

    this.logger.debug("Cleaned up batch data", { batchId });
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Close the Redis connection.
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }

  // ============================================================================
  // Private - Redis Commands
  // ============================================================================

  #registerCommands(): void {
    // Atomic idempotent success recording
    // Returns the current processed count (whether incremented or not)
    this.redis.defineCommand("recordSuccessIdempotent", {
      numberOfKeys: 3,
      lua: `
local processedItemsKey = KEYS[1]
local runsKey = KEYS[2]
local processedKey = KEYS[3]
local itemKey = ARGV[1]
local runId = ARGV[2]

-- Check if already processed (SADD returns 0 if member already exists)
local added = redis.call('SADD', processedItemsKey, itemKey)

if added == 1 then
  -- New item, record the success
  redis.call('RPUSH', runsKey, runId)
  redis.call('INCR', processedKey)
end

-- Return current count
local count = redis.call('GET', processedKey)
return count or '0'
      `,
    });

    // Atomic idempotent failure recording
    // Returns the current processed count (whether incremented or not)
    this.redis.defineCommand("recordFailureIdempotent", {
      numberOfKeys: 3,
      lua: `
local processedItemsKey = KEYS[1]
local failuresKey = KEYS[2]
local processedKey = KEYS[3]
local itemKey = ARGV[1]
local failureJson = ARGV[2]

-- Check if already processed (SADD returns 0 if member already exists)
local added = redis.call('SADD', processedItemsKey, itemKey)

if added == 1 then
  -- New item, record the failure
  redis.call('RPUSH', failuresKey, failureJson)
  redis.call('INCR', processedKey)
end

-- Return current count
local count = redis.call('GET', processedKey)
return count or '0'
      `,
    });
  }
}

// Extend Redis interface for custom commands
declare module "@internal/redis" {
  interface RedisCommander<Context> {
    recordSuccessIdempotent(
      processedItemsKey: string,
      runsKey: string,
      processedKey: string,
      itemKey: string,
      runId: string
    ): Promise<string>;

    recordFailureIdempotent(
      processedItemsKey: string,
      failuresKey: string,
      processedKey: string,
      itemKey: string,
      failureJson: string
    ): Promise<string>;
  }
}
