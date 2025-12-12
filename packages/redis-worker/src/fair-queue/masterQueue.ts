import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { jumpHash } from "@trigger.dev/core/v3/serverOnly";
import type { FairQueueKeyProducer, QueueWithScore } from "./types.js";

export interface MasterQueueOptions {
  redis: RedisOptions;
  keys: FairQueueKeyProducer;
  shardCount: number;
}

/**
 * Master queue manages the top-level queue of queues.
 *
 * Features:
 * - Sharding for horizontal scaling
 * - Consistent hashing for queue-to-shard assignment
 * - Queues scored by oldest message timestamp
 */
export class MasterQueue {
  private redis: Redis;
  private keys: FairQueueKeyProducer;
  private shardCount: number;

  constructor(private options: MasterQueueOptions) {
    this.redis = createRedisClient(options.redis);
    this.keys = options.keys;
    this.shardCount = Math.max(1, options.shardCount);

    this.#registerCommands();
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Get the shard ID for a queue.
   * Uses consistent hashing based on queue ID.
   */
  getShardForQueue(queueId: string): number {
    return this.#hashToShard(queueId);
  }

  /**
   * Add a queue to its master queue shard.
   * Updates the score to the oldest message timestamp.
   *
   * @param queueId - The queue identifier
   * @param oldestMessageTimestamp - Timestamp of the oldest message in the queue
   */
  async addQueue(queueId: string, oldestMessageTimestamp: number): Promise<void> {
    const shardId = this.getShardForQueue(queueId);
    const masterKey = this.keys.masterQueueKey(shardId);

    // Just use plain ZADD - it will add if not exists, or update if exists
    // The score represents the oldest message timestamp
    // We rely on the enqueue Lua scripts to set the correct score
    await this.redis.zadd(masterKey, oldestMessageTimestamp, queueId);
  }

  /**
   * Update a queue's score in the master queue.
   * This is typically called after dequeuing to update to the new oldest message.
   *
   * @param queueId - The queue identifier
   * @param newOldestTimestamp - New timestamp of the oldest message
   */
  async updateQueueScore(queueId: string, newOldestTimestamp: number): Promise<void> {
    const shardId = this.getShardForQueue(queueId);
    const masterKey = this.keys.masterQueueKey(shardId);

    await this.redis.zadd(masterKey, newOldestTimestamp, queueId);
  }

  /**
   * Remove a queue from its master queue shard.
   * Called when a queue becomes empty.
   *
   * @param queueId - The queue identifier
   */
  async removeQueue(queueId: string): Promise<void> {
    const shardId = this.getShardForQueue(queueId);
    const masterKey = this.keys.masterQueueKey(shardId);

    await this.redis.zrem(masterKey, queueId);
  }

  /**
   * Get queues from a shard, ordered by oldest message (lowest score first).
   *
   * @param shardId - The shard to query
   * @param limit - Maximum number of queues to return (default: 1000)
   * @param maxScore - Maximum score (timestamp) to include (default: now)
   */
  async getQueuesFromShard(
    shardId: number,
    limit: number = 1000,
    maxScore?: number
  ): Promise<QueueWithScore[]> {
    const masterKey = this.keys.masterQueueKey(shardId);
    const score = maxScore ?? Date.now();

    // Get queues with scores up to maxScore
    const results = await this.redis.zrangebyscore(
      masterKey,
      "-inf",
      score,
      "WITHSCORES",
      "LIMIT",
      0,
      limit
    );

    const queues: QueueWithScore[] = [];
    for (let i = 0; i < results.length; i += 2) {
      const queueId = results[i];
      const scoreStr = results[i + 1];
      if (queueId && scoreStr) {
        queues.push({
          queueId,
          score: parseFloat(scoreStr),
          tenantId: this.keys.extractTenantId(queueId),
        });
      }
    }

    return queues;
  }

  /**
   * Get the number of queues in a shard.
   */
  async getShardQueueCount(shardId: number): Promise<number> {
    const masterKey = this.keys.masterQueueKey(shardId);
    return await this.redis.zcard(masterKey);
  }

  /**
   * Get total queue count across all shards.
   */
  async getTotalQueueCount(): Promise<number> {
    const counts = await Promise.all(
      Array.from({ length: this.shardCount }, (_, i) => this.getShardQueueCount(i))
    );
    return counts.reduce((sum, count) => sum + count, 0);
  }

  /**
   * Atomically add a queue to master queue only if queue has messages.
   * Uses Lua script for atomicity.
   *
   * @param queueId - The queue identifier
   * @param queueKey - The actual queue sorted set key
   * @returns Whether the queue was added to the master queue
   */
  async addQueueIfNotEmpty(queueId: string, queueKey: string): Promise<boolean> {
    const shardId = this.getShardForQueue(queueId);
    const masterKey = this.keys.masterQueueKey(shardId);

    const result = await this.redis.addQueueIfNotEmpty(masterKey, queueKey, queueId);
    return result === 1;
  }

  /**
   * Atomically remove a queue from master queue only if queue is empty.
   * Uses Lua script for atomicity.
   *
   * @param queueId - The queue identifier
   * @param queueKey - The actual queue sorted set key
   * @returns Whether the queue was removed from the master queue
   */
  async removeQueueIfEmpty(queueId: string, queueKey: string): Promise<boolean> {
    const shardId = this.getShardForQueue(queueId);
    const masterKey = this.keys.masterQueueKey(shardId);

    const result = await this.redis.removeQueueIfEmpty(masterKey, queueKey, queueId);
    return result === 1;
  }

  /**
   * Close the Redis connection.
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  /**
   * Map queue ID to shard using Jump Consistent Hash.
   * Provides better distribution than djb2 and minimal reshuffling when shard count changes.
   */
  #hashToShard(queueId: string): number {
    return jumpHash(queueId, this.shardCount);
  }

  #registerCommands(): void {
    // Atomically add queue to master if it has messages
    this.redis.defineCommand("addQueueIfNotEmpty", {
      numberOfKeys: 2,
      lua: `
local masterKey = KEYS[1]
local queueKey = KEYS[2]
local queueId = ARGV[1]

-- Check if queue has any messages
local count = redis.call('ZCARD', queueKey)
if count == 0 then
  return 0
end

-- Get the oldest message timestamp (lowest score)
local oldest = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #oldest == 0 then
  return 0
end

local score = oldest[2]

-- Add to master queue with the oldest message score
redis.call('ZADD', masterKey, score, queueId)
return 1
      `,
    });

    // Atomically remove queue from master if it's empty
    this.redis.defineCommand("removeQueueIfEmpty", {
      numberOfKeys: 2,
      lua: `
local masterKey = KEYS[1]
local queueKey = KEYS[2]
local queueId = ARGV[1]

-- Check if queue is empty
local count = redis.call('ZCARD', queueKey)
if count > 0 then
  return 0
end

-- Remove from master queue
redis.call('ZREM', masterKey, queueId)
return 1
      `,
    });
  }
}

// Extend Redis interface for custom commands
declare module "@internal/redis" {
  interface RedisCommander<Context> {
    addQueueIfNotEmpty(masterKey: string, queueKey: string, queueId: string): Promise<number>;

    removeQueueIfEmpty(masterKey: string, queueKey: string, queueId: string): Promise<number>;
  }
}
