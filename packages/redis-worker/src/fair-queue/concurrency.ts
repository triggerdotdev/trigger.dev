import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import type {
  ConcurrencyCheckResult,
  ConcurrencyGroupConfig,
  ConcurrencyState,
  FairQueueKeyProducer,
  QueueDescriptor,
} from "./types.js";

/**
 * Page size for iterating a concurrency set's members (SSCAN COUNT) and cap on how many
 * members one sweep script invocation checks, bounding both the snapshot reads and the
 * time the atomic Lua script can hold up Redis when a set has accumulated many leaked
 * members.
 */
const SWEEP_MEMBER_CHUNK_SIZE = 500;

export interface ConcurrencyManagerOptions {
  redis: RedisOptions;
  keys: FairQueueKeyProducer;
  groups: ConcurrencyGroupConfig[];
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
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
  private logger: NonNullable<ConcurrencyManagerOptions["logger"]>;

  constructor(private options: ConcurrencyManagerOptions) {
    this.redis = createRedisClient(options.redis);
    this.keys = options.keys;
    this.groups = options.groups;
    this.groupsByName = new Map(options.groups.map((g) => [g.name, g]));
    this.logger = options.logger ?? {
      debug: () => {},
      error: () => {},
    };

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
    // Pass keys as KEYS array so ioredis applies keyPrefix correctly
    const keys = groupData.map((g) => g.key);
    const limits = groupData.map((g) => g.limit.toString());

    // Args order: messageId, ...limits (keys are passed separately)
    const result = await this.redis.reserveConcurrency(keys.length, keys, messageId, ...limits);

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

    this.#assertPipelineSucceeded(await pipeline.exec(), 1);
  }

  /**
   * Throw if any command in a released pipeline failed. ioredis resolves `exec()` even when
   * individual commands error, so an unchecked pipeline reports success while leaving the
   * slot held, which strands it permanently once the caller drops the in-flight record.
   */
  #assertPipelineSucceeded(
    results: Array<[Error | null, unknown]> | null,
    messageCount: number
  ): void {
    if (results === null) {
      throw new Error(
        `Concurrency release pipeline for ${messageCount} message(s) was discarded without executing`
      );
    }

    const errors = results
      .map(([error]) => error)
      .filter((error): error is Error => Boolean(error));

    if (errors.length > 0) {
      throw new Error(
        `Failed to release ${errors.length} of ${
          results?.length ?? 0
        } concurrency slot commands across ${messageCount} message(s): ${errors
          .map((error) => error.message)
          .join("; ")}`
      );
    }
  }

  /**
   * Release concurrency slots for multiple messages in a single pipeline.
   * More efficient than calling release() multiple times.
   */
  async releaseBatch(
    messages: Array<{ queue: QueueDescriptor; messageId: string }>
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }

    const pipeline = this.redis.pipeline();

    for (const { queue, messageId } of messages) {
      for (const group of this.groups) {
        const groupId = group.extractGroupId(queue);
        const key = this.keys.concurrencyKey(group.name, groupId);
        pipeline.srem(key, messageId);
      }
    }

    this.#assertPipelineSucceeded(await pipeline.exec(), messages.length);
  }

  /**
   * Remove concurrency set members that no longer correspond to an in-flight message,
   * healing slots leaked by failed releases. Scans every set of every group and, per
   * member, atomically removes it unless the message id appears in one of the given
   * in-flight data hashes. Sound because a message is registered in-flight before its
   * slot is reserved, so at the moment of the atomic check a member with no in-flight
   * record can only be a leak; if the message is about to be re-claimed, reserve simply
   * re-adds the member.
   *
   * @param inflightDataKeys - The in-flight data hash keys for every shard. The sweep
   *   refuses to run when this is empty, since with nowhere to look for running messages
   *   every member would look orphaned and all concurrency accounting would be erased.
   * @returns The message ids that were removed, and how many sets were checked
   */
  async sweepOrphanedSlots(
    inflightDataKeys: string[]
  ): Promise<{ scannedSets: number; removed: string[] }> {
    if (inflightDataKeys.length === 0) {
      this.logger.error(
        "Refusing to sweep concurrency slots without any in-flight data keys: every member would look orphaned and all concurrency accounting would be erased"
      );
      return { scannedSets: 0, removed: [] };
    }

    const keyPrefix = this.options.redis.keyPrefix ?? "";
    let scannedSets = 0;
    const removed: string[] = [];

    for (const group of this.groups) {
      const pattern = `${keyPrefix}${this.keys.concurrencyKey(group.name, "*")}`;
      let cursor = "0";

      do {
        const [nextCursor, foundKeys] = await this.redis.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          1000
        );
        cursor = nextCursor;

        for (const fullKey of foundKeys) {
          const key =
            keyPrefix && fullKey.startsWith(keyPrefix) ? fullKey.slice(keyPrefix.length) : fullKey;

          try {
            let sawMembers = false;
            let memberCursor = "0";

            do {
              const [nextMemberCursor, page] = await this.redis.sscan(
                key,
                memberCursor,
                "COUNT",
                SWEEP_MEMBER_CHUNK_SIZE
              );
              memberCursor = nextMemberCursor;

              if (page.length === 0) {
                continue;
              }
              sawMembers = true;

              for (let i = 0; i < page.length; i += SWEEP_MEMBER_CHUNK_SIZE) {
                const chunk = page.slice(i, i + SWEEP_MEMBER_CHUNK_SIZE);
                const removedIds = await this.redis.removeOrphanedConcurrencySlots(
                  1 + inflightDataKeys.length,
                  [key, ...inflightDataKeys],
                  ...chunk
                );
                removed.push(...removedIds);
              }
            } while (memberCursor !== "0");

            if (sawMembers) {
              scannedSets++;
            }
          } catch (error) {
            this.logger.error("Failed to sweep concurrency set, skipping it", {
              key,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } while (cursor !== "0");
    }

    return { scannedSets, removed };
  }

  /**
   * Get current concurrency for a specific group.
   */
  async getCurrentConcurrency(groupName: string, groupId: string): Promise<number> {
    const key = this.keys.concurrencyKey(groupName, groupId);
    return await this.redis.scard(key);
  }

  /**
   * Get available capacity for a queue across all concurrency groups.
   * Returns the minimum available capacity across all groups.
   */
  async getAvailableCapacity(queue: QueueDescriptor): Promise<number> {
    if (this.groups.length === 0) {
      return 0;
    }

    // Build group data for parallel fetching
    const groupData = this.groups.map((group) => ({
      group,
      groupId: group.extractGroupId(queue),
    }));

    // Fetch all current counts and limits in parallel
    const [currents, limits] = await Promise.all([
      Promise.all(
        groupData.map(({ group, groupId }) =>
          this.redis.scard(this.keys.concurrencyKey(group.name, groupId))
        )
      ),
      Promise.all(
        groupData.map(({ group, groupId }) =>
          group.getLimit(groupId).then((limit) => limit || group.defaultLimit)
        )
      ),
    ]);

    // Calculate minimum available capacity across all groups
    let minCapacity = Infinity;
    for (let i = 0; i < groupData.length; i++) {
      const available = Math.max(0, limits[i]! - currents[i]!);
      minCapacity = Math.min(minCapacity, available);
    }

    return minCapacity === Infinity ? 0 : minCapacity;
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
    // KEYS: concurrency set keys for each group (keyPrefix is applied by ioredis)
    // ARGV[1]: messageId
    // ARGV[2..n]: limits for each group (in same order as KEYS)
    this.redis.defineCommand("reserveConcurrency", {
      lua: `
local numGroups = #KEYS
local messageId = ARGV[1]

-- Check all groups first. A message that is already a member of a group's set passes
-- that group's check: re-admitting it does not increase concurrency (SADD is a no-op),
-- and counting its own leftover slot against it would let a message whose earlier
-- release failed block its own retry forever.
for i = 1, numGroups do
  local key = KEYS[i]
  local limit = tonumber(ARGV[1 + i])  -- Limits start at ARGV[2]

  if redis.call('SISMEMBER', key, messageId) == 0 then
    local current = redis.call('SCARD', key)

    if current >= limit then
      return 0  -- At capacity
    end
  end
end

-- All groups have capacity, add message to all
for i = 1, numGroups do
  local key = KEYS[i]
  redis.call('SADD', key, messageId)
end

return 1
      `,
    });

    // Atomic orphan sweep for one concurrency set
    // KEYS[1]: concurrency set key
    // KEYS[2..n]: in-flight data hash keys for every shard
    // ARGV: candidate messageIds (a snapshot of the set's members)
    this.redis.defineCommand("removeOrphanedConcurrencySlots", {
      lua: `
local concurrencyKey = KEYS[1]
local removedIds = {}

for i = 1, #ARGV do
  local messageId = ARGV[i]
  local inflight = false

  for j = 2, #KEYS do
    if redis.call('HEXISTS', KEYS[j], messageId) == 1 then
      inflight = true
      break
    end
  end

  if not inflight then
    if redis.call('SREM', concurrencyKey, messageId) == 1 then
      table.insert(removedIds, messageId)
    end
  end
end

return removedIds
      `,
    });
  }
}

// Extend Redis interface for custom commands
declare module "@internal/redis" {
  interface RedisCommander<Context> {
    reserveConcurrency(
      numKeys: number,
      keys: string[],
      messageId: string,
      ...limits: string[]
    ): Promise<number>;

    removeOrphanedConcurrencySlots(
      numKeys: number,
      keys: string[],
      ...messageIds: string[]
    ): Promise<string[]>;
  }
}
