import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { jumpHash } from "@trigger.dev/core/v3/serverOnly";
import type { ClaimResult, FairQueueKeyProducer, InFlightMessage } from "./types.js";

export interface VisibilityManagerOptions {
  redis: RedisOptions;
  keys: FairQueueKeyProducer;
  shardCount: number;
  defaultTimeoutMs: number;
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
}

/**
 * VisibilityManager handles message visibility timeouts for safe message processing.
 *
 * Features:
 * - Claim messages with visibility timeout
 * - Heartbeat to extend timeout
 * - Automatic reclaim of timed-out messages
 * - Per-shard in-flight tracking
 *
 * Data structures:
 * - In-flight sorted set: score = deadline timestamp, member = "{messageId}:{queueId}"
 * - In-flight data hash: field = messageId, value = JSON message data
 */
export class VisibilityManager {
  private redis: Redis;
  private keys: FairQueueKeyProducer;
  private shardCount: number;
  private defaultTimeoutMs: number;
  private logger: NonNullable<VisibilityManagerOptions["logger"]>;

  constructor(private options: VisibilityManagerOptions) {
    this.redis = createRedisClient(options.redis);
    this.keys = options.keys;
    this.shardCount = options.shardCount;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
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
   * Claim a message for processing.
   * Moves the message from its queue to the in-flight set with a visibility timeout.
   *
   * @param queueId - The queue to claim from
   * @param queueKey - The Redis key for the queue sorted set
   * @param queueItemsKey - The Redis key for the queue items hash
   * @param consumerId - ID of the consumer claiming the message
   * @param timeoutMs - Visibility timeout in milliseconds
   * @returns Claim result with the message if successful
   */
  async claim<TPayload = unknown>(
    queueId: string,
    queueKey: string,
    queueItemsKey: string,
    consumerId: string,
    timeoutMs?: number
  ): Promise<ClaimResult<TPayload>> {
    const timeout = timeoutMs ?? this.defaultTimeoutMs;
    const deadline = Date.now() + timeout;
    const shardId = this.#getShardForQueue(queueId);
    const inflightKey = this.keys.inflightKey(shardId);
    const inflightDataKey = this.keys.inflightDataKey(shardId);

    // Use Lua script to atomically:
    // 1. Pop oldest message from queue
    // 2. Add to in-flight set with deadline
    // 3. Store message data
    const result = await this.redis.claimMessage(
      queueKey,
      queueItemsKey,
      inflightKey,
      inflightDataKey,
      queueId,
      consumerId,
      deadline.toString()
    );

    if (!result) {
      return { claimed: false };
    }

    const [messageId, payloadJson] = result;

    try {
      const payload = JSON.parse(payloadJson) as TPayload;
      const message: InFlightMessage<TPayload> = {
        messageId,
        queueId,
        payload,
        deadline,
        consumerId,
      };

      this.logger.debug("Message claimed", {
        messageId,
        queueId,
        consumerId,
        deadline,
      });

      return { claimed: true, message };
    } catch (error) {
      // JSON parse error - message data is corrupted
      this.logger.error("Failed to parse claimed message", {
        messageId,
        queueId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Remove the corrupted message from in-flight
      await this.#removeFromInflight(shardId, messageId, queueId);

      return { claimed: false };
    }
  }

  /**
   * Extend the visibility timeout for a message (heartbeat).
   *
   * @param messageId - The message ID
   * @param queueId - The queue ID
   * @param extendMs - Additional milliseconds to add to the deadline
   * @returns true if the heartbeat was successful
   */
  async heartbeat(messageId: string, queueId: string, extendMs: number): Promise<boolean> {
    const shardId = this.#getShardForQueue(queueId);
    const inflightKey = this.keys.inflightKey(shardId);
    const member = this.#makeMember(messageId, queueId);
    const newDeadline = Date.now() + extendMs;

    // Use Lua script to atomically check existence and update score
    // ZADD XX returns 0 even on successful updates, so we use a custom command
    const result = await this.redis.heartbeatMessage(inflightKey, member, newDeadline.toString());

    const success = result === 1;

    if (success) {
      this.logger.debug("Heartbeat successful", {
        messageId,
        queueId,
        newDeadline,
      });
    }

    return success;
  }

  /**
   * Mark a message as successfully processed.
   * Removes the message from in-flight tracking.
   *
   * @param messageId - The message ID
   * @param queueId - The queue ID
   */
  async complete(messageId: string, queueId: string): Promise<void> {
    const shardId = this.#getShardForQueue(queueId);
    await this.#removeFromInflight(shardId, messageId, queueId);

    this.logger.debug("Message completed", {
      messageId,
      queueId,
    });
  }

  /**
   * Release a message back to its queue.
   * Used when processing fails or consumer wants to retry later.
   *
   * @param messageId - The message ID
   * @param queueId - The queue ID
   * @param queueKey - The Redis key for the queue
   * @param queueItemsKey - The Redis key for the queue items hash
   * @param masterQueueKey - The Redis key for the master queue
   * @param score - Optional score for the message (defaults to now)
   */
  async release<TPayload = unknown>(
    messageId: string,
    queueId: string,
    queueKey: string,
    queueItemsKey: string,
    masterQueueKey: string,
    score?: number
  ): Promise<void> {
    const shardId = this.#getShardForQueue(queueId);
    const inflightKey = this.keys.inflightKey(shardId);
    const inflightDataKey = this.keys.inflightDataKey(shardId);
    const member = this.#makeMember(messageId, queueId);
    const messageScore = score ?? Date.now();

    // Use Lua script to atomically:
    // 1. Get message data from in-flight
    // 2. Remove from in-flight
    // 3. Add back to queue
    // 4. Update master queue to ensure queue is picked up
    await this.redis.releaseMessage(
      inflightKey,
      inflightDataKey,
      queueKey,
      queueItemsKey,
      masterQueueKey,
      member,
      messageId,
      messageScore.toString(),
      queueId
    );

    this.logger.debug("Message released", {
      messageId,
      queueId,
      score: messageScore,
    });
  }

  /**
   * Reclaim timed-out messages from a shard.
   * Returns messages to their original queues.
   *
   * @param shardId - The shard to check
   * @param getQueueKeys - Function to get queue keys for a queue ID
   * @returns Number of messages reclaimed
   */
  async reclaimTimedOut(
    shardId: number,
    getQueueKeys: (queueId: string) => {
      queueKey: string;
      queueItemsKey: string;
      masterQueueKey: string;
    }
  ): Promise<number> {
    const inflightKey = this.keys.inflightKey(shardId);
    const inflightDataKey = this.keys.inflightDataKey(shardId);
    const now = Date.now();

    // Get all messages past their deadline
    const timedOut = await this.redis.zrangebyscore(
      inflightKey,
      "-inf",
      now,
      "WITHSCORES",
      "LIMIT",
      0,
      100 // Process in batches
    );

    let reclaimed = 0;

    for (let i = 0; i < timedOut.length; i += 2) {
      const member = timedOut[i];
      const originalScore = timedOut[i + 1];
      if (!member || !originalScore) {
        continue;
      }
      const { messageId, queueId } = this.#parseMember(member);
      const { queueKey, queueItemsKey, masterQueueKey } = getQueueKeys(queueId);

      try {
        // Re-add to queue with original score (or now if not available)
        const score = parseFloat(originalScore) || now;
        await this.redis.releaseMessage(
          inflightKey,
          inflightDataKey,
          queueKey,
          queueItemsKey,
          masterQueueKey,
          member,
          messageId,
          score.toString(),
          queueId
        );

        reclaimed++;

        this.logger.debug("Reclaimed timed-out message", {
          messageId,
          queueId,
          originalScore,
        });
      } catch (error) {
        this.logger.error("Failed to reclaim message", {
          messageId,
          queueId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return reclaimed;
  }

  /**
   * Get all in-flight messages for a shard.
   */
  async getInflightMessages(shardId: number): Promise<
    Array<{
      messageId: string;
      queueId: string;
      deadline: number;
    }>
  > {
    const inflightKey = this.keys.inflightKey(shardId);
    const results = await this.redis.zrange(inflightKey, 0, -1, "WITHSCORES");

    const messages: Array<{ messageId: string; queueId: string; deadline: number }> = [];

    for (let i = 0; i < results.length; i += 2) {
      const member = results[i];
      const deadlineStr = results[i + 1];
      if (!member || !deadlineStr) {
        continue;
      }
      const deadline = parseFloat(deadlineStr);
      const { messageId, queueId } = this.#parseMember(member);

      messages.push({ messageId, queueId, deadline });
    }

    return messages;
  }

  /**
   * Get count of in-flight messages for a shard.
   */
  async getInflightCount(shardId: number): Promise<number> {
    const inflightKey = this.keys.inflightKey(shardId);
    return await this.redis.zcard(inflightKey);
  }

  /**
   * Get total in-flight count across all shards.
   */
  async getTotalInflightCount(): Promise<number> {
    const counts = await Promise.all(
      Array.from({ length: this.shardCount }, (_, i) => this.getInflightCount(i))
    );
    return counts.reduce((sum, count) => sum + count, 0);
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
   * Must use same algorithm as MasterQueue for consistency.
   */
  #getShardForQueue(queueId: string): number {
    return jumpHash(queueId, this.shardCount);
  }

  #makeMember(messageId: string, queueId: string): string {
    return `${messageId}:${queueId}`;
  }

  #parseMember(member: string): { messageId: string; queueId: string } {
    const colonIndex = member.indexOf(":");
    if (colonIndex === -1) {
      return { messageId: member, queueId: "" };
    }
    return {
      messageId: member.substring(0, colonIndex),
      queueId: member.substring(colonIndex + 1),
    };
  }

  async #removeFromInflight(shardId: number, messageId: string, queueId: string): Promise<void> {
    const inflightKey = this.keys.inflightKey(shardId);
    const inflightDataKey = this.keys.inflightDataKey(shardId);
    const member = this.#makeMember(messageId, queueId);

    const pipeline = this.redis.pipeline();
    pipeline.zrem(inflightKey, member);
    pipeline.hdel(inflightDataKey, messageId);
    await pipeline.exec();
  }

  #registerCommands(): void {
    // Atomic claim: pop from queue, add to in-flight
    this.redis.defineCommand("claimMessage", {
      numberOfKeys: 4,
      lua: `
local queueKey = KEYS[1]
local queueItemsKey = KEYS[2]
local inflightKey = KEYS[3]
local inflightDataKey = KEYS[4]

local queueId = ARGV[1]
local consumerId = ARGV[2]
local deadline = tonumber(ARGV[3])

-- Get oldest message from queue
local items = redis.call('ZRANGE', queueKey, 0, 0)
if #items == 0 then
  return nil
end

local messageId = items[1]

-- Get message data
local payload = redis.call('HGET', queueItemsKey, messageId)
if not payload then
  -- Message data missing, remove from queue and return nil
  redis.call('ZREM', queueKey, messageId)
  return nil
end

-- Remove from queue
redis.call('ZREM', queueKey, messageId)
redis.call('HDEL', queueItemsKey, messageId)

-- Add to in-flight set with deadline
local member = messageId .. ':' .. queueId
redis.call('ZADD', inflightKey, deadline, member)

-- Store message data for potential release
redis.call('HSET', inflightDataKey, messageId, payload)

return {messageId, payload}
      `,
    });

    // Atomic release: remove from in-flight, add back to queue, update master queue
    this.redis.defineCommand("releaseMessage", {
      numberOfKeys: 5,
      lua: `
local inflightKey = KEYS[1]
local inflightDataKey = KEYS[2]
local queueKey = KEYS[3]
local queueItemsKey = KEYS[4]
local masterQueueKey = KEYS[5]

local member = ARGV[1]
local messageId = ARGV[2]
local score = tonumber(ARGV[3])
local queueId = ARGV[4]

-- Get message data from in-flight
local payload = redis.call('HGET', inflightDataKey, messageId)
if not payload then
  -- Message not in in-flight or already released
  return 0
end

-- Remove from in-flight
redis.call('ZREM', inflightKey, member)
redis.call('HDEL', inflightDataKey, messageId)

-- Add back to queue
redis.call('ZADD', queueKey, score, messageId)
redis.call('HSET', queueItemsKey, messageId, payload)

-- Update master queue with oldest message timestamp
-- This ensures delayed messages don't push the queue priority to the future
-- when there are other ready messages in the queue
local oldest = redis.call('ZRANGE', queueKey, 0, 0, 'WITHSCORES')
if #oldest >= 2 then
  redis.call('ZADD', masterQueueKey, oldest[2], queueId)
end

return 1
      `,
    });

    // Atomic heartbeat: check if member exists and update score
    // ZADD XX returns 0 even on successful updates (it counts new additions only)
    // So we need to check existence first with ZSCORE
    this.redis.defineCommand("heartbeatMessage", {
      numberOfKeys: 1,
      lua: `
local inflightKey = KEYS[1]
local member = ARGV[1]
local newDeadline = tonumber(ARGV[2])

-- Check if member exists in the in-flight set
local score = redis.call('ZSCORE', inflightKey, member)
if not score then
  return 0
end

-- Update the deadline
redis.call('ZADD', inflightKey, 'XX', newDeadline, member)
return 1
      `,
    });
  }
}

// Extend Redis interface for custom commands
declare module "@internal/redis" {
  interface RedisCommander<Context> {
    claimMessage(
      queueKey: string,
      queueItemsKey: string,
      inflightKey: string,
      inflightDataKey: string,
      queueId: string,
      consumerId: string,
      deadline: string
    ): Promise<[string, string] | null>;

    releaseMessage(
      inflightKey: string,
      inflightDataKey: string,
      queueKey: string,
      queueItemsKey: string,
      masterQueueKey: string,
      member: string,
      messageId: string,
      score: string,
      queueId: string
    ): Promise<number>;

    heartbeatMessage(inflightKey: string, member: string, newDeadline: string): Promise<number>;
  }
}
