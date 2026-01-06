import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { BaseScheduler } from "../scheduler.js";
import type {
  DRRSchedulerConfig,
  FairQueueKeyProducer,
  SchedulerContext,
  TenantQueues,
  QueueWithScore,
} from "../types.js";

/**
 * Deficit Round Robin (DRR) Scheduler.
 *
 * DRR ensures fair processing across tenants by:
 * - Allocating a "quantum" of credits to each tenant per round
 * - Accumulating unused credits as "deficit"
 * - Processing from tenants with available deficit
 * - Capping deficit to prevent starvation
 *
 * Key improvements over basic implementations:
 * - Atomic deficit operations using Lua scripts
 * - Efficient iteration through tenants
 * - Automatic deficit cleanup for inactive tenants
 */
export class DRRScheduler extends BaseScheduler {
  private redis: Redis;
  private keys: FairQueueKeyProducer;
  private quantum: number;
  private maxDeficit: number;
  private masterQueueLimit: number;
  private logger: NonNullable<DRRSchedulerConfig["logger"]>;

  constructor(private config: DRRSchedulerConfig) {
    super();
    this.redis = createRedisClient(config.redis);
    this.keys = config.keys;
    this.quantum = config.quantum;
    this.maxDeficit = config.maxDeficit;
    this.masterQueueLimit = config.masterQueueLimit ?? 1000;
    this.logger = config.logger ?? {
      debug: () => {},
      error: () => {},
    };

    this.#registerCommands();
  }

  // ============================================================================
  // FairScheduler Implementation
  // ============================================================================

  /**
   * Select queues for processing using DRR algorithm.
   *
   * Algorithm:
   * 1. Get all queues from the master shard
   * 2. Group by tenant
   * 3. Filter out tenants at concurrency capacity
   * 4. Add quantum to each tenant's deficit (atomically)
   * 5. Select queues from tenants with deficit >= 1
   * 6. Order tenants by deficit (highest first for fairness)
   */
  async selectQueues(
    masterQueueShard: string,
    consumerId: string,
    context: SchedulerContext
  ): Promise<TenantQueues[]> {
    // Get all queues from the master shard
    const queues = await this.#getQueuesFromShard(masterQueueShard);

    if (queues.length === 0) {
      return [];
    }

    // Group queues by tenant
    const queuesByTenant = this.groupQueuesByTenant(
      queues.map((q) => ({ queueId: q.queueId, tenantId: q.tenantId }))
    );

    // Get unique tenant IDs
    const tenantIds = Array.from(queuesByTenant.keys());

    // Add quantum to all active tenants atomically
    const deficits = await this.#addQuantumToTenants(tenantIds);

    // Build tenant data with deficits
    const tenantData: Array<{
      tenantId: string;
      deficit: number;
      queues: string[];
      isAtCapacity: boolean;
    }> = await Promise.all(
      tenantIds.map(async (tenantId, index) => {
        const isAtCapacity = await context.isAtCapacity("tenant", tenantId);
        return {
          tenantId,
          deficit: deficits[index] ?? 0,
          queues: queuesByTenant.get(tenantId) ?? [],
          isAtCapacity,
        };
      })
    );

    // Filter out tenants at capacity or with no deficit
    const eligibleTenants = tenantData.filter(
      (t) => !t.isAtCapacity && t.deficit >= 1
    );

    // Log tenants blocked by capacity
    const blockedTenants = tenantData.filter((t) => t.isAtCapacity);
    if (blockedTenants.length > 0) {
      this.logger.debug("DRR: tenants blocked by concurrency", {
        blockedCount: blockedTenants.length,
        blockedTenants: blockedTenants.map((t) => t.tenantId),
      });
    }

    // Sort by deficit (highest first for fairness)
    eligibleTenants.sort((a, b) => b.deficit - a.deficit);

    this.logger.debug("DRR: queue selection complete", {
      totalQueues: queues.length,
      totalTenants: tenantIds.length,
      eligibleTenants: eligibleTenants.length,
      topTenantDeficit: eligibleTenants[0]?.deficit,
    });

    // Convert to TenantQueues format
    return eligibleTenants.map((t) => ({
      tenantId: t.tenantId,
      queues: t.queues,
    }));
  }

  /**
   * Record that a message was processed from a tenant.
   * Decrements the tenant's deficit.
   */
  override async recordProcessed(tenantId: string, _queueId: string): Promise<void> {
    await this.#decrementDeficit(tenantId);
  }

  /**
   * Record that multiple messages were processed from a tenant.
   * Decrements the tenant's deficit by count atomically.
   */
  override async recordProcessedBatch(
    tenantId: string,
    _queueId: string,
    count: number
  ): Promise<void> {
    await this.#decrementDeficitBatch(tenantId, count);
  }

  override async close(): Promise<void> {
    await this.redis.quit();
  }

  // ============================================================================
  // Public Methods for Deficit Management
  // ============================================================================

  /**
   * Get the current deficit for a tenant.
   */
  async getDeficit(tenantId: string): Promise<number> {
    const key = this.#deficitKey();
    const value = await this.redis.hget(key, tenantId);
    return value ? parseFloat(value) : 0;
  }

  /**
   * Reset deficit for a tenant.
   * Used when a tenant has no more active queues.
   */
  async resetDeficit(tenantId: string): Promise<void> {
    const key = this.#deficitKey();
    await this.redis.hdel(key, tenantId);
  }

  /**
   * Get all tenant deficits.
   */
  async getAllDeficits(): Promise<Map<string, number>> {
    const key = this.#deficitKey();
    const data = await this.redis.hgetall(key);
    const result = new Map<string, number>();
    for (const [tenantId, value] of Object.entries(data)) {
      result.set(tenantId, parseFloat(value));
    }
    return result;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  #deficitKey(): string {
    // Use a fixed key for DRR deficit tracking
    return `${this.keys.masterQueueKey(0).split(":")[0]}:drr:deficit`;
  }

  async #getQueuesFromShard(shardKey: string): Promise<QueueWithScore[]> {
    const now = Date.now();
    const results = await this.redis.zrangebyscore(
      shardKey,
      "-inf",
      now,
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

  /**
   * Add quantum to multiple tenants atomically.
   * Returns the new deficit values.
   */
  async #addQuantumToTenants(tenantIds: string[]): Promise<number[]> {
    if (tenantIds.length === 0) {
      return [];
    }

    const key = this.#deficitKey();

    // Use Lua script for atomic quantum addition with capping
    const results = await this.redis.drrAddQuantum(
      key,
      this.quantum.toString(),
      this.maxDeficit.toString(),
      ...tenantIds
    );

    return results.map((r) => parseFloat(r));
  }

  /**
   * Decrement deficit for a tenant atomically.
   */
  async #decrementDeficit(tenantId: string): Promise<number> {
    const key = this.#deficitKey();

    // Use Lua script to decrement and ensure non-negative
    const result = await this.redis.drrDecrementDeficit(key, tenantId);
    return parseFloat(result);
  }

  /**
   * Decrement deficit for a tenant by a count atomically.
   */
  async #decrementDeficitBatch(tenantId: string, count: number): Promise<number> {
    const key = this.#deficitKey();

    // Use Lua script to decrement by count and ensure non-negative
    const result = await this.redis.drrDecrementDeficitBatch(key, tenantId, count.toString());
    return parseFloat(result);
  }

  #registerCommands(): void {
    // Atomic quantum addition with capping for multiple tenants
    this.redis.defineCommand("drrAddQuantum", {
      numberOfKeys: 1,
      lua: `
local deficitKey = KEYS[1]
local quantum = tonumber(ARGV[1])
local maxDeficit = tonumber(ARGV[2])
local results = {}

for i = 3, #ARGV do
  local tenantId = ARGV[i]
  
  -- Add quantum to deficit
  local newDeficit = redis.call('HINCRBYFLOAT', deficitKey, tenantId, quantum)
  newDeficit = tonumber(newDeficit)
  
  -- Cap at maxDeficit
  if newDeficit > maxDeficit then
    redis.call('HSET', deficitKey, tenantId, maxDeficit)
    newDeficit = maxDeficit
  end
  
  table.insert(results, tostring(newDeficit))
end

return results
      `,
    });

    // Atomic deficit decrement with floor at 0
    this.redis.defineCommand("drrDecrementDeficit", {
      numberOfKeys: 1,
      lua: `
local deficitKey = KEYS[1]
local tenantId = ARGV[1]

local newDeficit = redis.call('HINCRBYFLOAT', deficitKey, tenantId, -1)
newDeficit = tonumber(newDeficit)

-- Floor at 0
if newDeficit < 0 then
  redis.call('HSET', deficitKey, tenantId, 0)
  newDeficit = 0
end

return tostring(newDeficit)
      `,
    });

    // Atomic deficit decrement by count with floor at 0
    this.redis.defineCommand("drrDecrementDeficitBatch", {
      numberOfKeys: 1,
      lua: `
local deficitKey = KEYS[1]
local tenantId = ARGV[1]
local count = tonumber(ARGV[2])

local newDeficit = redis.call('HINCRBYFLOAT', deficitKey, tenantId, -count)
newDeficit = tonumber(newDeficit)

-- Floor at 0
if newDeficit < 0 then
  redis.call('HSET', deficitKey, tenantId, 0)
  newDeficit = 0
end

return tostring(newDeficit)
      `,
    });
  }
}

// Extend Redis interface for custom commands
declare module "@internal/redis" {
  interface RedisCommander<Context> {
    drrAddQuantum(
      deficitKey: string,
      quantum: string,
      maxDeficit: string,
      ...tenantIds: string[]
    ): Promise<string[]>;

    drrDecrementDeficit(deficitKey: string, tenantId: string): Promise<string>;

    drrDecrementDeficitBatch(
      deficitKey: string,
      tenantId: string,
      count: string
    ): Promise<string>;
  }
}

