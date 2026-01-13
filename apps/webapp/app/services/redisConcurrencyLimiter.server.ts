import { createRedisClient, type RedisClient, type RedisWithClusterOptions } from "~/redis.server";

export type RedisConcurrencyLimiterOptions = {
  redis: RedisWithClusterOptions;
  /** Prefix for Redis keys */
  keyPrefix: string;
  /** Auto-expire stale entries after this many seconds (default: 300 = 5 minutes) */
  expiryTimeInSeconds?: number;
};

export type AcquireResult =
  | { success: true }
  | { success: false; reason: "key_limit" | "global_limit" };

/**
 * A generic Redis-based concurrency limiter that supports two-level limiting:
 * - Key-level limit (e.g., per organization)
 * - Global limit (across all keys)
 *
 * Uses Redis sorted sets with timestamps to track active requests,
 * with automatic expiry of stale entries as a safety net.
 */
export class RedisConcurrencyLimiter {
  private redis: RedisClient;
  private keyPrefix: string;
  private expiryTimeInSeconds: number;

  constructor(options: RedisConcurrencyLimiterOptions) {
    this.redis = createRedisClient(`${options.keyPrefix}:limiter`, options.redis);
    this.keyPrefix = options.keyPrefix;
    this.expiryTimeInSeconds = options.expiryTimeInSeconds ?? 300; // 5 minutes default
    this.#registerCommands();
  }

  /**
   * Acquire a concurrency slot atomically checking both key and global limits.
   *
   * @param options.key - The key to limit (e.g., organizationId)
   * @param options.requestId - A unique identifier for this request
   * @param options.keyLimit - The maximum concurrent requests for this key
   * @param options.globalLimit - The maximum concurrent requests globally
   * @returns Success or failure with reason
   */
  async acquire(options: {
    key: string;
    requestId: string;
    keyLimit: number;
    globalLimit: number;
  }): Promise<AcquireResult> {
    const { key, requestId, keyLimit, globalLimit } = options;
    const keyKey = this.#getKeyKey(key);
    const globalKey = this.#getGlobalKey();
    const now = Date.now();
    const cutoffTime = now - this.expiryTimeInSeconds * 1000;

    // @ts-expect-error - Custom command defined via defineCommand
    const result = await this.redis.acquireConcurrency(
      keyKey,
      globalKey,
      now.toString(),
      requestId,
      this.expiryTimeInSeconds.toString(),
      cutoffTime.toString(),
      keyLimit.toString(),
      globalLimit.toString()
    );

    // Result: 1 = success, 0 = key limit exceeded, -1 = global limit exceeded
    if (result === 1) {
      return { success: true };
    } else if (result === 0) {
      return { success: false, reason: "key_limit" };
    } else {
      return { success: false, reason: "global_limit" };
    }
  }

  /**
   * Release a concurrency slot.
   *
   * @param options.key - The key that was used to acquire
   * @param options.requestId - The request identifier used to acquire
   */
  async release(options: { key: string; requestId: string }): Promise<void> {
    const { key, requestId } = options;
    const keyKey = this.#getKeyKey(key);
    const globalKey = this.#getGlobalKey();

    // Remove from both sets in a single round trip
    await this.redis.pipeline().zrem(keyKey, requestId).zrem(globalKey, requestId).exec();
  }

  #getKeyKey(key: string): string {
    return `${this.keyPrefix}:key:${key}`;
  }

  #getGlobalKey(): string {
    return `${this.keyPrefix}:global`;
  }

  #registerCommands() {
    this.redis.defineCommand("acquireConcurrency", {
      numberOfKeys: 2,
      lua: /* lua */ `
        local keyKey = KEYS[1]
        local globalKey = KEYS[2]

        local timestamp = tonumber(ARGV[1])
        local requestId = ARGV[2]
        local expiryTime = tonumber(ARGV[3])
        local cutoffTime = tonumber(ARGV[4])
        local keyLimit = tonumber(ARGV[5])
        local globalLimit = tonumber(ARGV[6])

        -- Remove expired entries from both sets
        redis.call('ZREMRANGEBYSCORE', keyKey, '-inf', cutoffTime)
        redis.call('ZREMRANGEBYSCORE', globalKey, '-inf', cutoffTime)

        -- Check global limit first (more restrictive check)
        local globalCount = redis.call('ZCARD', globalKey)
        if globalCount >= globalLimit then
            return -1  -- Global limit exceeded
        end

        -- Check key-specific limit
        local keyCount = redis.call('ZCARD', keyKey)
        if keyCount >= keyLimit then
            return 0  -- Key limit exceeded
        end

        -- Add the request to both sorted sets
        redis.call('ZADD', keyKey, timestamp, requestId)
        redis.call('ZADD', globalKey, timestamp, requestId)

        -- Set expiry on both keys
        redis.call('EXPIRE', keyKey, expiryTime)
        redis.call('EXPIRE', globalKey, expiryTime)

        return 1  -- Success
      `,
    });
  }
}
