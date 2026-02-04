import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { BaseScheduler } from "../scheduler.js";
import type {
  FairQueueKeyProducer,
  SchedulerContext,
  TenantQueues,
  QueueWithScore,
} from "../types.js";

export interface RoundRobinSchedulerConfig {
  redis: RedisOptions;
  keys: FairQueueKeyProducer;
  /** Maximum queues to fetch from master queue per iteration */
  masterQueueLimit?: number;
}

/**
 * Round Robin Scheduler.
 *
 * Simple scheduler that processes tenants in strict rotation order.
 * Maintains a "last served" pointer in Redis to track position.
 *
 * Features:
 * - Predictable ordering (good for debugging)
 * - Fair rotation through all tenants
 * - No weighting or bias
 */
export class RoundRobinScheduler extends BaseScheduler {
  private redis: Redis;
  private keys: FairQueueKeyProducer;
  private masterQueueLimit: number;

  constructor(private config: RoundRobinSchedulerConfig) {
    super();
    this.redis = createRedisClient(config.redis);
    this.keys = config.keys;
    this.masterQueueLimit = config.masterQueueLimit ?? 1000;
  }

  // ============================================================================
  // FairScheduler Implementation
  // ============================================================================

  async selectQueues(
    masterQueueShard: string,
    consumerId: string,
    context: SchedulerContext
  ): Promise<TenantQueues[]> {
    const now = Date.now();

    // Get all queues from master shard
    const queues = await this.#getQueuesFromShard(masterQueueShard, now);

    if (queues.length === 0) {
      return [];
    }

    // Group queues by tenant
    const queuesByTenant = new Map<string, string[]>();
    const tenantOrder: string[] = [];

    for (const queue of queues) {
      if (!queuesByTenant.has(queue.tenantId)) {
        queuesByTenant.set(queue.tenantId, []);
        tenantOrder.push(queue.tenantId);
      }
      queuesByTenant.get(queue.tenantId)!.push(queue.queueId);
    }

    // Get last served index
    const lastServedIndex = await this.#getLastServedIndex(masterQueueShard);

    // Rotate tenant order based on last served
    const rotatedTenants = this.#rotateArray(tenantOrder, lastServedIndex);

    // Filter out tenants at capacity
    const eligibleTenants: TenantQueues[] = [];

    for (const tenantId of rotatedTenants) {
      const isAtCapacity = await context.isAtCapacity("tenant", tenantId);
      if (!isAtCapacity) {
        const tenantQueues = queuesByTenant.get(tenantId) ?? [];
        // Sort queues by age (oldest first based on original scores)
        eligibleTenants.push({
          tenantId,
          queues: tenantQueues,
        });
      }
    }

    // Update last served index to the first eligible tenant
    const firstEligible = eligibleTenants[0];
    if (firstEligible) {
      const firstTenantIndex = tenantOrder.indexOf(firstEligible.tenantId);
      await this.#setLastServedIndex(masterQueueShard, firstTenantIndex + 1);
    }

    return eligibleTenants;
  }

  override async close(): Promise<void> {
    await this.redis.quit();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  async #getQueuesFromShard(shardKey: string, maxScore: number): Promise<QueueWithScore[]> {
    const results = await this.redis.zrangebyscore(
      shardKey,
      "-inf",
      maxScore,
      "WITHSCORES",
      "LIMIT",
      0,
      this.masterQueueLimit
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

  #lastServedKey(shardKey: string): string {
    return `${shardKey}:rr:lastServed`;
  }

  async #getLastServedIndex(shardKey: string): Promise<number> {
    const key = this.#lastServedKey(shardKey);
    const value = await this.redis.get(key);
    return value ? parseInt(value, 10) : 0;
  }

  async #setLastServedIndex(shardKey: string, index: number): Promise<void> {
    const key = this.#lastServedKey(shardKey);
    await this.redis.set(key, index.toString());
  }

  #rotateArray<T>(array: T[], startIndex: number): T[] {
    if (array.length === 0) return [];
    const normalizedIndex = startIndex % array.length;
    return [...array.slice(normalizedIndex), ...array.slice(0, normalizedIndex)];
  }
}

