import { Callback, Result } from "ioredis";
import { createRedisClient, RedisClient, RedisWithClusterOptions } from "~/redis.server";
import { logger } from "../logger.server";

export type RealtimeConcurrencyLimiterOptions = {
  redis: RedisWithClusterOptions;
  keyPrefix: string;
  /** How long a tracked request lives before it's swept as stale (seconds). */
  expiryTimeInSeconds?: number;
  connectionName?: string;
};

/**
 * Per-environment concurrent-connection limiter for realtime long-polls; a standalone copy of the limiter in
 * `realtimeClient.server.ts` (identical Lua + key shape, different key prefix) so the native backend tracks independently.
 */
export class RealtimeConcurrencyLimiter {
  private redis: RedisClient;
  private expiryTimeInSeconds: number;

  constructor(private options: RealtimeConcurrencyLimiterOptions) {
    this.redis = createRedisClient(
      options.connectionName ?? "trigger:realtime:native:concurrency",
      options.redis
    );
    this.expiryTimeInSeconds = options.expiryTimeInSeconds ?? 60 * 5;
    this.#registerCommands();
  }

  async incrementAndCheck(environmentId: string, requestId: string, limit: number): Promise<boolean> {
    const key = this.#getKey(environmentId);
    const now = Date.now();

    const result = await this.redis.incrementAndCheckRealtimeNativeConcurrency(
      key,
      now.toString(),
      requestId,
      this.expiryTimeInSeconds.toString(),
      (now - this.expiryTimeInSeconds * 1000).toString(),
      limit.toString()
    );

    return result === 1;
  }

  async decrement(environmentId: string, requestId: string): Promise<void> {
    const key = this.#getKey(environmentId);
    await this.redis.zrem(key, requestId);
  }

  #getKey(environmentId: string): string {
    return `${this.options.keyPrefix}:${environmentId}`;
  }

  #registerCommands() {
    this.redis.defineCommand("incrementAndCheckRealtimeNativeConcurrency", {
      numberOfKeys: 1,
      lua: /* lua */ `
        local concurrencyKey = KEYS[1]

        local timestamp = tonumber(ARGV[1])
        local requestId = ARGV[2]
        local expiryTime = tonumber(ARGV[3])
        local cutoffTime = tonumber(ARGV[4])
        local limit = tonumber(ARGV[5])

        -- Remove expired entries
        redis.call('ZREMRANGEBYSCORE', concurrencyKey, '-inf', cutoffTime)

        -- Add the new request to the sorted set
        redis.call('ZADD', concurrencyKey, timestamp, requestId)

        -- Set the expiry time on the key
        redis.call('EXPIRE', concurrencyKey, expiryTime)

        -- Get the total number of concurrent requests
        local totalRequests = redis.call('ZCARD', concurrencyKey)

        -- Check if the limit has been exceeded
        if totalRequests > limit then
            redis.call('ZREM', concurrencyKey, requestId)
            return 0
        end

        return 1
      `,
    });

    this.redis.on("error", (error) => {
      logger.error("[realtimeConcurrencyLimiter] redis error", { error });
    });
  }
}

declare module "ioredis" {
  interface RedisCommander<Context> {
    incrementAndCheckRealtimeNativeConcurrency(
      key: string,
      timestamp: string,
      requestId: string,
      expiryTime: string,
      cutoffTime: string,
      limit: string,
      callback?: Callback<number>
    ): Result<number, Context>;
  }
}
