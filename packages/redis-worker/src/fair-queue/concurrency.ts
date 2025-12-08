import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import type {
  ConcurrencyCheckResult,
  ConcurrencyGroupConfig,
  ConcurrencyState,
  FairQueueKeyProducer,
  QueueDescriptor,
} from "./types.js";

export interface ConcurrencyManagerOptions {
  redis: RedisOptions;
  keys: FairQueueKeyProducer;
  groups: ConcurrencyGroupConfig[];
}

/**
 * ConcurrencyManager handles multi-level concurrency tracking and limiting.
 *
 * Features:
 * - Multiple concurrent concurrency groups (tenant, org, project, etc.)
 * - Atomic reserve/release operations using Lua scripts
 * - Efficient batch checking of all groups
 */
export class ConcurrencyManager {
  private redis: Redis;
  private keys: FairQueueKeyProducer;
  private groups: ConcurrencyGroupConfig[];
  private groupsByName: Map<string, ConcurrencyGroupConfig>;

  constructor(private options: ConcurrencyManagerOptions) {
    this.redis = createRedisClient(options.redis);
    this.keys = options.keys;
    this.groups = options.groups;
    this.groupsByName = new Map(options.groups.map((g) => [g.name, g]));

    this.#registerCommands();
  }

  // ============================================================================
  // Public Methods
  // ============================================================================

  /**
   * Check if a message can be processed given all concurrency constraints.
   * Checks all configured groups and returns the first one at capacity.
   */
  async canProcess(queue: QueueDescriptor): Promise<ConcurrencyCheckResult> {
    for (const group of this.groups) {
      const groupId = group.extractGroupId(queue);
      const isAtCapacity = await this.isAtCapacity(group.name, groupId);

      if (isAtCapacity) {
        const state = await this.getState(group.name, groupId);
        return {
          allowed: false,
          blockedBy: state,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Reserve concurrency slots for a message across all groups.
   * Atomic - either all groups are reserved or none.
   *
   * @returns true if reservation successful, false if any group is at capacity
   */
  async reserve(queue: QueueDescriptor, messageId: string): Promise<boolean> {
    // Build list of group keys and limits
    const groupData = await Promise.all(
      this.groups.map(async (group) => {
        const groupId = group.extractGroupId(queue);
        const limit = await group.getLimit(groupId);
        return {
          key: this.keys.concurrencyKey(group.name, groupId),
          limit: limit || group.defaultLimit,
        };
      })
    );

    // Use Lua script for atomic multi-group reservation
    const keys = groupData.map((g) => g.key);
    const limits = groupData.map((g) => g.limit.toString());

    // Args order: numGroups, messageId, ...keys, ...limits
    const result = await this.redis.reserveConcurrency(
      keys.length.toString(),
      messageId,
      ...keys,
      ...limits
    );

    return result === 1;
  }

  /**
   * Release concurrency slots for a message across all groups.
   */
  async release(queue: QueueDescriptor, messageId: string): Promise<void> {
    const pipeline = this.redis.pipeline();

    for (const group of this.groups) {
      const groupId = group.extractGroupId(queue);
      const key = this.keys.concurrencyKey(group.name, groupId);
      pipeline.srem(key, messageId);
    }

    await pipeline.exec();
  }

  /**
   * Get current concurrency for a specific group.
   */
  async getCurrentConcurrency(groupName: string, groupId: string): Promise<number> {
    const key = this.keys.concurrencyKey(groupName, groupId);
    return await this.redis.scard(key);
  }

  /**
   * Get concurrency limit for a specific group.
   */
  async getConcurrencyLimit(groupName: string, groupId: string): Promise<number> {
    const group = this.groupsByName.get(groupName);
    if (!group) {
      throw new Error(`Unknown concurrency group: ${groupName}`);
    }
    return (await group.getLimit(groupId)) || group.defaultLimit;
  }

  /**
   * Check if a group is at capacity.
   */
  async isAtCapacity(groupName: string, groupId: string): Promise<boolean> {
    const [current, limit] = await Promise.all([
      this.getCurrentConcurrency(groupName, groupId),
      this.getConcurrencyLimit(groupName, groupId),
    ]);
    return current >= limit;
  }

  /**
   * Get full state for a group.
   */
  async getState(groupName: string, groupId: string): Promise<ConcurrencyState> {
    const [current, limit] = await Promise.all([
      this.getCurrentConcurrency(groupName, groupId),
      this.getConcurrencyLimit(groupName, groupId),
    ]);
    return {
      groupName,
      groupId,
      current,
      limit,
    };
  }

  /**
   * Get all active message IDs for a group.
   */
  async getActiveMessages(groupName: string, groupId: string): Promise<string[]> {
    const key = this.keys.concurrencyKey(groupName, groupId);
    return await this.redis.smembers(key);
  }

  /**
   * Force-clear concurrency for a group (use with caution).
   * Useful for cleanup after crashes.
   */
  async clearGroup(groupName: string, groupId: string): Promise<void> {
    const key = this.keys.concurrencyKey(groupName, groupId);
    await this.redis.del(key);
  }

  /**
   * Remove a specific message from concurrency tracking.
   * Useful for cleanup.
   */
  async removeMessage(messageId: string, queue: QueueDescriptor): Promise<void> {
    await this.release(queue, messageId);
  }

  /**
   * Get configured group names.
   */
  getGroupNames(): string[] {
    return this.groups.map((g) => g.name);
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

  #registerCommands(): void {
    // Atomic multi-group reservation
    // Keys: concurrency set keys for each group
    // Args: messageId, then limits for each group
    this.redis.defineCommand("reserveConcurrency", {
      numberOfKeys: 0, // Will pass number of keys in ARGV
      lua: `
local numGroups = tonumber(ARGV[1])
local messageId = ARGV[2]

-- Check all groups first
for i = 1, numGroups do
  local key = ARGV[2 + i]  -- Keys start at ARGV[3]
  local limit = tonumber(ARGV[2 + numGroups + i])  -- Limits come after keys
  local current = redis.call('SCARD', key)
  
  if current >= limit then
    return 0  -- At capacity
  end
end

-- All groups have capacity, add message to all
for i = 1, numGroups do
  local key = ARGV[2 + i]
  redis.call('SADD', key, messageId)
end

return 1
      `,
    });
  }
}

// Extend Redis interface for custom commands
declare module "@internal/redis" {
  interface RedisCommander<Context> {
    reserveConcurrency(...args: string[]): Promise<number>;
  }
}

