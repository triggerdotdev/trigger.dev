import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import seedrandom from "seedrandom";
import { BaseScheduler } from "../scheduler.js";
import type {
  FairQueueKeyProducer,
  SchedulerContext,
  TenantQueues,
  QueueWithScore,
  WeightedSchedulerBiases,
  WeightedSchedulerConfig,
} from "../types.js";

interface TenantConcurrency {
  current: number;
  limit: number;
}

interface TenantSnapshot {
  tenantId: string;
  concurrency: TenantConcurrency;
  queues: Array<{ queueId: string; age: number }>;
}

interface QueueSnapshot {
  id: string;
  tenants: Map<string, TenantSnapshot>;
  queues: Array<{ queueId: string; tenantId: string; age: number }>;
}

const defaultBiases: WeightedSchedulerBiases = {
  concurrencyLimitBias: 0,
  availableCapacityBias: 0,
  queueAgeRandomization: 0,
};

/**
 * Weighted Shuffle Scheduler.
 *
 * Uses weighted random selection to balance between:
 * - Concurrency limit (higher limits get more weight)
 * - Available capacity (tenants with more capacity get more weight)
 * - Queue age (older queues get priority, with configurable randomization)
 *
 * Features:
 * - Snapshot caching to reduce Redis calls
 * - Configurable biases for fine-tuning
 * - Maximum tenant count to limit iteration
 */
export class WeightedScheduler extends BaseScheduler {
  private redis: Redis;
  private keys: FairQueueKeyProducer;
  private rng: seedrandom.PRNG;
  private biases: WeightedSchedulerBiases;
  private defaultTenantLimit: number;
  private masterQueueLimit: number;
  private reuseSnapshotCount: number;
  private maximumTenantCount: number;

  // Snapshot cache
  private snapshotCache: Map<string, { snapshot: QueueSnapshot; reuseCount: number }> = new Map();

  constructor(private config: WeightedSchedulerConfig) {
    super();
    this.redis = createRedisClient(config.redis);
    this.keys = config.keys;
    this.rng = seedrandom(config.seed);
    this.biases = config.biases ?? defaultBiases;
    this.defaultTenantLimit = config.defaultTenantConcurrencyLimit ?? 100;
    this.masterQueueLimit = config.masterQueueLimit ?? 100;
    this.reuseSnapshotCount = config.reuseSnapshotCount ?? 0;
    this.maximumTenantCount = config.maximumTenantCount ?? 0;
  }

  // ============================================================================
  // FairScheduler Implementation
  // ============================================================================

  async selectQueues(
    masterQueueShard: string,
    consumerId: string,
    context: SchedulerContext
  ): Promise<TenantQueues[]> {
    const snapshot = await this.#getOrCreateSnapshot(
      masterQueueShard,
      consumerId,
      context
    );

    if (snapshot.queues.length === 0) {
      return [];
    }

    // Shuffle tenants based on weights
    const shuffledTenants = this.#shuffleTenantsByWeight(snapshot);

    // Order queues within each tenant
    return shuffledTenants.map((tenantId) => ({
      tenantId,
      queues: this.#orderQueuesForTenant(snapshot, tenantId),
    }));
  }

  override async close(): Promise<void> {
    this.snapshotCache.clear();
    await this.redis.quit();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  async #getOrCreateSnapshot(
    masterQueueShard: string,
    consumerId: string,
    context: SchedulerContext
  ): Promise<QueueSnapshot> {
    const cacheKey = `${masterQueueShard}:${consumerId}`;

    // Check cache
    if (this.reuseSnapshotCount > 0) {
      const cached = this.snapshotCache.get(cacheKey);
      if (cached && cached.reuseCount < this.reuseSnapshotCount) {
        this.snapshotCache.set(cacheKey, {
          snapshot: cached.snapshot,
          reuseCount: cached.reuseCount + 1,
        });
        return cached.snapshot;
      }
    }

    // Create new snapshot
    const snapshot = await this.#createSnapshot(masterQueueShard, context);

    // Cache if enabled
    if (this.reuseSnapshotCount > 0) {
      this.snapshotCache.set(cacheKey, { snapshot, reuseCount: 0 });
    }

    return snapshot;
  }

  async #createSnapshot(
    masterQueueShard: string,
    context: SchedulerContext
  ): Promise<QueueSnapshot> {
    const now = Date.now();

    // Get queues from master shard
    let rawQueues = await this.#getQueuesFromShard(masterQueueShard, now);

    if (rawQueues.length === 0) {
      return { id: crypto.randomUUID(), tenants: new Map(), queues: [] };
    }

    // Apply maximum tenant count if configured
    if (this.maximumTenantCount > 0) {
      rawQueues = this.#selectTopTenantQueues(rawQueues);
    }

    // Build tenant data
    const tenantIds = new Set<string>();
    const queuesByTenant = new Map<string, Array<{ queueId: string; age: number }>>();

    for (const queue of rawQueues) {
      tenantIds.add(queue.tenantId);
      const tenantQueues = queuesByTenant.get(queue.tenantId) ?? [];
      tenantQueues.push({
        queueId: queue.queueId,
        age: now - queue.score,
      });
      queuesByTenant.set(queue.tenantId, tenantQueues);
    }

    // Get concurrency for each tenant
    const tenants = new Map<string, TenantSnapshot>();
    for (const tenantId of tenantIds) {
      const [current, limit] = await Promise.all([
        context.getCurrentConcurrency("tenant", tenantId),
        context.getConcurrencyLimit("tenant", tenantId),
      ]);

      // Skip tenants at capacity
      if (current >= limit) {
        continue;
      }

      tenants.set(tenantId, {
        tenantId,
        concurrency: { current, limit },
        queues: queuesByTenant.get(tenantId) ?? [],
      });
    }

    // Build final queue list (only from non-capacity tenants)
    const queues = rawQueues
      .filter((q) => tenants.has(q.tenantId))
      .map((q) => ({
        queueId: q.queueId,
        tenantId: q.tenantId,
        age: now - q.score,
      }));

    return {
      id: crypto.randomUUID(),
      tenants,
      queues,
    };
  }

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

  #selectTopTenantQueues(queues: QueueWithScore[]): QueueWithScore[] {
    // Group by tenant and calculate average age
    const queuesByTenant = new Map<string, QueueWithScore[]>();
    for (const queue of queues) {
      const tenantQueues = queuesByTenant.get(queue.tenantId) ?? [];
      tenantQueues.push(queue);
      queuesByTenant.set(queue.tenantId, tenantQueues);
    }

    // Calculate average age per tenant
    const tenantAges = Array.from(queuesByTenant.entries()).map(([tenantId, tQueues]) => {
      const avgAge = tQueues.reduce((sum, q) => sum + q.score, 0) / tQueues.length;
      return { tenantId, avgAge };
    });

    // Weighted shuffle to select top N tenants
    const maxAge = Math.max(...tenantAges.map((t) => t.avgAge));
    const weightedTenants = tenantAges.map((t) => ({
      tenantId: t.tenantId,
      weight: t.avgAge / maxAge,
    }));

    const selectedTenants = new Set<string>();
    let remaining = [...weightedTenants];
    let totalWeight = remaining.reduce((sum, t) => sum + t.weight, 0);

    while (selectedTenants.size < this.maximumTenantCount && remaining.length > 0) {
      let random = this.rng() * totalWeight;
      let index = 0;

      while (random > 0 && index < remaining.length) {
        const item = remaining[index];
        if (item) {
          random -= item.weight;
        }
        index++;
      }
      index = Math.max(0, index - 1);

      const selected = remaining[index];
      if (selected) {
        selectedTenants.add(selected.tenantId);
        totalWeight -= selected.weight;
        remaining.splice(index, 1);
      }
    }

    // Return queues only from selected tenants
    return queues.filter((q) => selectedTenants.has(q.tenantId));
  }

  #shuffleTenantsByWeight(snapshot: QueueSnapshot): string[] {
    const tenantIds = Array.from(snapshot.tenants.keys());

    if (tenantIds.length === 0) {
      return [];
    }

    const { concurrencyLimitBias, availableCapacityBias } = this.biases;

    // If no biases, do simple shuffle
    if (concurrencyLimitBias === 0 && availableCapacityBias === 0) {
      return this.#shuffle(tenantIds);
    }

    // Calculate weights
    const maxLimit = Math.max(
      ...tenantIds.map((id) => snapshot.tenants.get(id)!.concurrency.limit)
    );

    const weightedTenants = tenantIds.map((tenantId) => {
      const tenant = snapshot.tenants.get(tenantId)!;
      let weight = 1;

      // Concurrency limit bias
      if (concurrencyLimitBias > 0) {
        const normalizedLimit = tenant.concurrency.limit / maxLimit;
        weight *= 1 + Math.pow(normalizedLimit * concurrencyLimitBias, 2);
      }

      // Available capacity bias
      if (availableCapacityBias > 0) {
        const usedPercentage = tenant.concurrency.current / tenant.concurrency.limit;
        const availableBonus = 1 - usedPercentage;
        weight *= 1 + Math.pow(availableBonus * availableCapacityBias, 2);
      }

      return { tenantId, weight };
    });

    return this.#weightedShuffle(weightedTenants);
  }

  #orderQueuesForTenant(snapshot: QueueSnapshot, tenantId: string): string[] {
    const tenant = snapshot.tenants.get(tenantId);
    if (!tenant || tenant.queues.length === 0) {
      return [];
    }

    const queues = [...tenant.queues];
    const { queueAgeRandomization } = this.biases;

    // Strict age-based ordering
    if (queueAgeRandomization === 0) {
      return queues.sort((a, b) => b.age - a.age).map((q) => q.queueId);
    }

    // Weighted random based on age
    const maxAge = Math.max(...queues.map((q) => q.age));
    const weightedQueues = queues.map((q) => ({
      queue: q,
      weight: 1 + (q.age / maxAge) * queueAgeRandomization,
    }));

    const result: string[] = [];
    let remaining = [...weightedQueues];
    let totalWeight = remaining.reduce((sum, q) => sum + q.weight, 0);

    while (remaining.length > 0) {
      let random = this.rng() * totalWeight;
      let index = 0;

      while (random > 0 && index < remaining.length) {
        const item = remaining[index];
        if (item) {
          random -= item.weight;
        }
        index++;
      }
      index = Math.max(0, index - 1);

      const selected = remaining[index];
      if (selected) {
        result.push(selected.queue.queueId);
        totalWeight -= selected.weight;
        remaining.splice(index, 1);
      }
    }

    return result;
  }

  #shuffle<T>(array: T[]): T[] {
    const result = [...array];
    for (let i = result.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      const temp = result[i];
      const swapValue = result[j];
      if (temp !== undefined && swapValue !== undefined) {
        result[i] = swapValue;
        result[j] = temp;
      }
    }
    return result;
  }

  #weightedShuffle(items: Array<{ tenantId: string; weight: number }>): string[] {
    const result: string[] = [];
    let remaining = [...items];
    let totalWeight = remaining.reduce((sum, item) => sum + item.weight, 0);

    while (remaining.length > 0) {
      let random = this.rng() * totalWeight;
      let index = 0;

      while (random > 0 && index < remaining.length) {
        const item = remaining[index];
        if (item) {
          random -= item.weight;
        }
        index++;
      }
      index = Math.max(0, index - 1);

      const selected = remaining[index];
      if (selected) {
        result.push(selected.tenantId);
        totalWeight -= selected.weight;
        remaining.splice(index, 1);
      }
    }

    return result;
  }
}

