import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { jumpHash } from "@trigger.dev/core/v3/serverOnly";
import type { FairQueueKeyProducer, QueueWithScore } from "./types.js";

export interface TenantDispatchOptions {
  redis: RedisOptions;
  keys: FairQueueKeyProducer;
  shardCount: number;
}

export interface TenantWithScore {
  tenantId: string;
  score: number;
}

/**
 * TenantDispatch manages the two-level tenant dispatch index.
 *
 * Level 1 - Dispatch Index (per shard):
 *   Key: {prefix}:dispatch:{shardId}
 *   ZSET of tenantIds scored by oldest message timestamp across their queues.
 *   Only tenants with queues containing messages appear here.
 *
 * Level 2 - Per-Tenant Queue Index:
 *   Key: {prefix}:tenantq:{tenantId}
 *   ZSET of queueIds scored by oldest message timestamp in that queue.
 *
 * This replaces the flat master queue for new enqueues, isolating each tenant's
 * queue backlog so the scheduler iterates tenants (not queues) at Level 1.
 */
export class TenantDispatch {
  private redis: Redis;
  private keys: FairQueueKeyProducer;
  private shardCount: number;

  constructor(private options: TenantDispatchOptions) {
    this.redis = createRedisClient(options.redis);
    this.keys = options.keys;
    this.shardCount = Math.max(1, options.shardCount);
  }

  /**
   * Get the shard ID for a queue.
   * Uses the same jump consistent hash as MasterQueue for consistency.
   */
  getShardForQueue(queueId: string): number {
    return jumpHash(queueId, this.shardCount);
  }

  /**
   * Get eligible tenants from a dispatch shard (Level 1).
   * Returns tenants ordered by oldest message (lowest score first).
   */
  async getTenantsFromShard(
    shardId: number,
    limit: number = 1000,
    maxScore?: number
  ): Promise<TenantWithScore[]> {
    const dispatchKey = this.keys.dispatchKey(shardId);
    const score = maxScore ?? Date.now();

    const results = await this.redis.zrangebyscore(
      dispatchKey,
      "-inf",
      score,
      "WITHSCORES",
      "LIMIT",
      0,
      limit
    );

    const tenants: TenantWithScore[] = [];
    for (let i = 0; i < results.length; i += 2) {
      const tenantId = results[i];
      const scoreStr = results[i + 1];
      if (tenantId && scoreStr) {
        tenants.push({
          tenantId,
          score: parseFloat(scoreStr),
        });
      }
    }

    return tenants;
  }

  /**
   * Get queues for a specific tenant (Level 2).
   * Returns queues ordered by oldest message (lowest score first).
   */
  async getQueuesForTenant(
    tenantId: string,
    limit: number = 1000,
    maxScore?: number
  ): Promise<QueueWithScore[]> {
    const tenantQueueKey = this.keys.tenantQueueIndexKey(tenantId);
    const score = maxScore ?? Date.now();

    const results = await this.redis.zrangebyscore(
      tenantQueueKey,
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
          tenantId,
        });
      }
    }

    return queues;
  }

  /**
   * Get the number of tenants in a dispatch shard.
   */
  async getShardTenantCount(shardId: number): Promise<number> {
    const dispatchKey = this.keys.dispatchKey(shardId);
    return await this.redis.zcard(dispatchKey);
  }

  /**
   * Get total tenant count across all dispatch shards.
   * Note: tenants may appear in multiple shards, so this may overcount.
   */
  async getTotalTenantCount(): Promise<number> {
    const counts = await Promise.all(
      Array.from({ length: this.shardCount }, (_, i) => this.getShardTenantCount(i))
    );
    return counts.reduce((sum, count) => sum + count, 0);
  }

  /**
   * Get the number of queues for a tenant.
   */
  async getTenantQueueCount(tenantId: string): Promise<number> {
    const tenantQueueKey = this.keys.tenantQueueIndexKey(tenantId);
    return await this.redis.zcard(tenantQueueKey);
  }

  /**
   * Remove a tenant from a specific dispatch shard.
   */
  async removeTenantFromShard(shardId: number, tenantId: string): Promise<void> {
    const dispatchKey = this.keys.dispatchKey(shardId);
    await this.redis.zrem(dispatchKey, tenantId);
  }

  /**
   * Add a tenant to a dispatch shard with the given score.
   */
  async addTenantToShard(shardId: number, tenantId: string, score: number): Promise<void> {
    const dispatchKey = this.keys.dispatchKey(shardId);
    await this.redis.zadd(dispatchKey, score, tenantId);
  }

  /**
   * Remove a queue from a tenant's queue index.
   */
  async removeQueueFromTenant(tenantId: string, queueId: string): Promise<void> {
    const tenantQueueKey = this.keys.tenantQueueIndexKey(tenantId);
    await this.redis.zrem(tenantQueueKey, queueId);
  }

  /**
   * Close the Redis connection.
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}
