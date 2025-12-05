import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import type {
  BatchItem,
  BatchMeta,
  BatchQueueKeyProducer,
  DRRConfig,
  DRRDequeueResult,
} from "./types.js";

export type DRRSchedulerOptions = {
  redis: RedisOptions;
  keys: BatchQueueKeyProducer;
  config: DRRConfig;
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
};

/**
 * Deficit Round Robin Scheduler for fair batch processing.
 *
 * Simplified two-level queue structure:
 * - Master queue: sorted set of "{envId}:{batchId}" members, scored by creation time
 * - Per-batch queues: items for each batch
 *
 * DRR ensures fair processing across environments:
 * - Each environment gets a quantum of credits per round
 * - Credits accumulate as deficit when not used
 * - Deficit is capped to prevent starvation
 */
export class DRRScheduler {
  private redis: Redis;
  private keys: BatchQueueKeyProducer;
  private config: DRRConfig;
  private logger: NonNullable<DRRSchedulerOptions["logger"]>;

  constructor(private options: DRRSchedulerOptions) {
    this.redis = createRedisClient(options.redis, {
      onError: (error) => {
        this.logger.error("DRRScheduler Redis error", { error: String(error) });
      },
    });
    this.keys = options.keys;
    this.config = options.config;
    this.logger = options.logger ?? {
      debug: () => {},
      error: () => {},
    };

    this.#registerCommands();
  }

  /**
   * Get all batches from master queue, oldest first.
   * Returns array of {envId, batchId} objects.
   */
  async getBatches(): Promise<Array<{ envId: string; batchId: string }>> {
    const masterQueueKey = this.keys.masterQueueKey();
    const members = await this.redis.zrange(masterQueueKey, 0, -1);
    return members.map((member) => this.keys.parseMasterQueueMember(member));
  }

  /**
   * Get unique active environments from the master queue.
   */
  async getActiveEnvironments(): Promise<string[]> {
    const batches = await this.getBatches();
    const envSet = new Set(batches.map((b) => b.envId));
    return Array.from(envSet);
  }

  /**
   * Get the current deficit for an environment.
   */
  async getDeficit(envId: string): Promise<number> {
    const deficitKey = this.keys.deficitHashKey();
    const deficit = await this.redis.hget(deficitKey, envId);
    return deficit ? parseFloat(deficit) : 0;
  }

  /**
   * Set the deficit for an environment.
   */
  async setDeficit(envId: string, deficit: number): Promise<void> {
    const deficitKey = this.keys.deficitHashKey();
    await this.redis.hset(deficitKey, envId, Math.min(deficit, this.config.maxDeficit).toString());
  }

  /**
   * Add quantum to an environment's deficit and return the new value.
   */
  async addQuantum(envId: string): Promise<number> {
    const deficitKey = this.keys.deficitHashKey();
    const newDeficitStr = await this.redis.hincrbyfloat(deficitKey, envId, this.config.quantum);
    const newDeficit = parseFloat(newDeficitStr);
    // Cap at maxDeficit
    if (newDeficit > this.config.maxDeficit) {
      await this.redis.hset(deficitKey, envId, this.config.maxDeficit.toString());
      return this.config.maxDeficit;
    }
    return newDeficit;
  }

  /**
   * Decrement an environment's deficit by 1 (after processing an item).
   */
  async decrementDeficit(envId: string): Promise<number> {
    const deficitKey = this.keys.deficitHashKey();
    const newDeficitStr = await this.redis.hincrbyfloat(deficitKey, envId, -1);
    const newDeficit = parseFloat(newDeficitStr);
    return Math.max(0, newDeficit);
  }

  /**
   * Reset an environment's deficit.
   */
  async resetDeficit(envId: string): Promise<void> {
    const deficitKey = this.keys.deficitHashKey();
    await this.redis.hdel(deficitKey, envId);
  }

  /**
   * Check if an environment has any pending batches.
   */
  async envHasBatches(envId: string): Promise<boolean> {
    const batches = await this.getBatches();
    return batches.some((b) => b.envId === envId);
  }

  /**
   * Dequeue a single item from a batch using the Lua script for atomicity.
   * Returns null if the batch has no more items.
   */
  async dequeueItem(
    batchId: string,
    envId: string
  ): Promise<{
    itemIndex: number;
    item: BatchItem;
    isBatchComplete: boolean;
  } | null> {
    const masterQueueMember = this.keys.masterQueueMember(envId, batchId);

    const result = await this.redis.drrDequeueItem(
      this.keys.batchQueueKey(batchId),
      this.keys.batchItemsKey(batchId),
      this.keys.masterQueueKey(),
      masterQueueMember
    );

    if (!result) {
      return null;
    }

    const [itemIndexStr, itemJson, isBatchCompleteStr] = result;
    const itemIndex = parseInt(itemIndexStr, 10);
    const item = JSON.parse(itemJson) as BatchItem;
    const isBatchComplete = isBatchCompleteStr === "1";

    return { itemIndex, item, isBatchComplete };
  }

  /**
   * Get batch metadata.
   */
  async getBatchMeta(batchId: string): Promise<BatchMeta | null> {
    const metaKey = this.keys.batchMetaKey(batchId);
    const metaJson = await this.redis.get(metaKey);
    if (!metaJson) {
      return null;
    }
    return JSON.parse(metaJson) as BatchMeta;
  }

  /**
   * Record a successful run for a batch and increment processed count.
   * Returns the new processed count.
   */
  async recordSuccess(batchId: string, runId: string): Promise<number> {
    const runsKey = this.keys.batchRunsKey(batchId);
    const processedKey = this.keys.batchProcessedCountKey(batchId);

    // Use a pipeline to atomically record and increment
    const pipeline = this.redis.pipeline();
    pipeline.rpush(runsKey, runId);
    pipeline.incr(processedKey);

    const results = await pipeline.exec();
    // incr result is the second command, returns [error, value]
    const incrResult = results?.[1];
    if (incrResult?.[0]) {
      throw incrResult[0];
    }
    return incrResult?.[1] as number;
  }

  /**
   * Record a failure for a batch item and increment processed count.
   * Returns the new processed count.
   */
  async recordFailure(
    batchId: string,
    failure: {
      index: number;
      taskIdentifier: string;
      payload?: string;
      options?: Record<string, unknown>;
      error: string;
      errorCode?: string;
    }
  ): Promise<number> {
    const failuresKey = this.keys.batchFailuresKey(batchId);
    const processedKey = this.keys.batchProcessedCountKey(batchId);
    const failureRecord = {
      ...failure,
      timestamp: Date.now(),
    };

    // Use a pipeline to atomically record and increment
    const pipeline = this.redis.pipeline();
    pipeline.rpush(failuresKey, JSON.stringify(failureRecord));
    pipeline.incr(processedKey);

    const results = await pipeline.exec();
    // incr result is the second command, returns [error, value]
    const incrResult = results?.[1];
    if (incrResult?.[0]) {
      throw incrResult[0];
    }
    return incrResult?.[1] as number;
  }

  /**
   * Get all successful run IDs for a batch.
   */
  async getSuccessfulRuns(batchId: string): Promise<string[]> {
    const runsKey = this.keys.batchRunsKey(batchId);
    return await this.redis.lrange(runsKey, 0, -1);
  }

  /**
   * Get all failures for a batch.
   */
  async getFailures(batchId: string): Promise<
    Array<{
      index: number;
      taskIdentifier: string;
      payload?: string;
      options?: Record<string, unknown>;
      error: string;
      errorCode?: string;
      timestamp: number;
    }>
  > {
    const failuresKey = this.keys.batchFailuresKey(batchId);
    const failureJsons = await this.redis.lrange(failuresKey, 0, -1);
    return failureJsons.map((json) => JSON.parse(json));
  }

  /**
   * Clean up all Redis keys for a completed batch.
   */
  async cleanupBatch(batchId: string): Promise<void> {
    const keys = [
      this.keys.batchQueueKey(batchId),
      this.keys.batchItemsKey(batchId),
      this.keys.batchMetaKey(batchId),
      this.keys.batchRunsKey(batchId),
      this.keys.batchFailuresKey(batchId),
      this.keys.batchProcessedCountKey(batchId),
    ];
    await this.redis.del(...keys);
  }

  /**
   * Perform one DRR iteration: process items from batches with fair scheduling.
   * Returns the items that were dequeued for processing.
   */
  async performDRRIteration(): Promise<DRRDequeueResult[]> {
    const results: DRRDequeueResult[] = [];
    const batches = await this.getBatches();

    if (batches.length === 0) {
      return results;
    }

    // Track which envs we've added quantum to this round
    const envsProcessedThisRound = new Set<string>();

    // Iterate through batches (oldest first) and process based on env deficit
    for (const { envId, batchId } of batches) {
      // Add quantum to env if we haven't already this round
      if (!envsProcessedThisRound.has(envId)) {
        await this.addQuantum(envId);
        envsProcessedThisRound.add(envId);
      }

      // Check if env has deficit to spend
      const currentDeficit = await this.getDeficit(envId);
      if (currentDeficit < 1) {
        // Skip this batch - env has no deficit left
        continue;
      }

      // Get batch metadata
      const meta = await this.getBatchMeta(batchId);
      if (!meta) {
        this.logger.error("Batch metadata not found", { batchId, envId });
        // Clean up orphaned batch from master queue
        const member = this.keys.masterQueueMember(envId, batchId);
        await this.redis.zrem(this.keys.masterQueueKey(), member);
        continue;
      }

      // Dequeue an item from the batch
      const dequeueResult = await this.dequeueItem(batchId, envId);
      if (!dequeueResult) {
        // Batch is empty (should have been cleaned up by Lua script)
        this.logger.debug("Batch has no more items", { batchId, envId });
        continue;
      }

      // Decrement deficit
      await this.decrementDeficit(envId);

      // Check if env has more batches after this one
      const envHasMoreBatches = dequeueResult.isBatchComplete
        ? await this.envHasBatches(envId)
        : true;

      results.push({
        envId,
        batchId,
        itemIndex: dequeueResult.itemIndex,
        item: dequeueResult.item,
        meta,
        isBatchComplete: dequeueResult.isBatchComplete,
        envHasMoreBatches,
      });

      // If env has no more batches, reset its deficit
      if (dequeueResult.isBatchComplete && !envHasMoreBatches) {
        await this.resetDeficit(envId);
      }
    }

    return results;
  }

  /**
   * Close the Redis connection.
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }

  #registerCommands() {
    // Atomic dequeue of a single item from a batch
    // Simplified: only handles batch queue and master queue (no env batches)
    this.redis.defineCommand("drrDequeueItem", {
      numberOfKeys: 3,
      lua: `
local batchQueueKey = KEYS[1]
local batchItemsKey = KEYS[2]
local masterQueueKey = KEYS[3]

local masterQueueMember = ARGV[1]

-- Get the first item from the batch queue (lowest score = first index)
local items = redis.call('ZRANGE', batchQueueKey, 0, 0, 'WITHSCORES')

if #items == 0 then
  -- Batch is empty, remove from master queue
  redis.call('ZREM', masterQueueKey, masterQueueMember)
  return nil
end

local itemIndex = items[1]

-- Get the item payload from the items hash
local itemJson = redis.call('HGET', batchItemsKey, itemIndex)

if not itemJson then
  -- Item not found, remove from queue and return nil
  redis.call('ZREM', batchQueueKey, itemIndex)
  return nil
end

-- Remove the item from the queue and items hash
redis.call('ZREM', batchQueueKey, itemIndex)
redis.call('HDEL', batchItemsKey, itemIndex)

-- Check if batch is now empty
local remainingCount = redis.call('ZCARD', batchQueueKey)
local isBatchComplete = "0"

if remainingCount == 0 then
  isBatchComplete = "1"
  -- Remove batch from master queue
  redis.call('ZREM', masterQueueKey, masterQueueMember)
end

return {itemIndex, itemJson, isBatchComplete}
      `,
    });
  }
}

// Extend Redis interface to include our custom command
declare module "@internal/redis" {
  interface RedisCommander<Context> {
    drrDequeueItem(
      batchQueueKey: string,
      batchItemsKey: string,
      masterQueueKey: string,
      masterQueueMember: string
    ): Promise<[string, string, string] | null>;
  }
}
