import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import type { FairQueueKeyProducer, RateLimitRequest, RateLimitCheckResult } from "./types.js";

export interface RateLimitManagerOptions {
  redis: RedisOptions;
  keys: FairQueueKeyProducer;
}

export class RateLimitManager {
  private redis: Redis;
  private keys: FairQueueKeyProducer;

  constructor(options: RateLimitManagerOptions) {
    this.redis = createRedisClient(options.redis);
    this.keys = options.keys;

    this.#registerCommands();
  }

  /**
   * Upsert a static rate limit configuration.
   */
  async upsertStaticConfig(key: string, limit: number, windowMs: number): Promise<void> {
    const configKey = `rate_limit_config:${key}`;
    await this.redis.hset(configKey, {
      limit: limit.toString(),
      windowMs: windowMs.toString(),
    });
  }

  /**
   * Get multiple static rate limit configurations.
   */
  async getStaticConfigs(keys: string[]): Promise<Map<string, { limit: number; windowMs: number } | null>> {
    if (keys.length === 0) {
      return new Map();
    }

    const pipeline = this.redis.pipeline();
    for (const key of keys) {
      pipeline.hgetall(`rate_limit_config:${key}`);
    }

    const results = await pipeline.exec();
    const map = new Map<string, { limit: number; windowMs: number } | null>();

    if (!results) {
      return map;
    }

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const [err, result] = results[i]!;

      if (err || !result || Object.keys(result).length === 0) {
        map.set(key, null);
      } else {
        const res = result as Record<string, string>;
        map.set(key, {
          limit: parseInt(res.limit!, 10),
          windowMs: parseInt(res.windowMs!, 10),
        });
      }
    }

    return map;
  }

  /**
   * Check and consume rate limits atomically.
   */
  async checkAndConsume(requests: RateLimitRequest[]): Promise<RateLimitCheckResult> {
    if (requests.length === 0) {
      return { allowed: true };
    }

    const now = Date.now();
    const keys: string[] = [];
    const args: string[] = [now.toString()];

    // Fetch all static configs in parallel
    const staticRequests = requests.filter((r) => r.isStatic);
    let staticConfigs = new Map<string, { limit: number; windowMs: number } | null>();
    
    if (staticRequests.length > 0) {
      staticConfigs = await this.getStaticConfigs(staticRequests.map((r) => r.key));
    }

    for (const req of requests) {
      let limit = req.limit;
      let windowMs = req.windowMs;

      if (req.isStatic) {
        const config = staticConfigs.get(req.key);
        if (!config) {
          // If static config is missing, we reject safely
          return { allowed: false, resetAt: now + 60000 }; // Fallback delay
        }
        limit = config.limit;
        windowMs = config.windowMs;
      }

      if (limit === undefined || windowMs === undefined) {
        throw new Error(`Rate limit configuration missing for key: ${req.key}`);
      }

      if (limit === 0) {
        return { allowed: false, resetAt: now + windowMs };
      }

      // Calculate the current window start time
      const windowStart = Math.floor(now / windowMs) * windowMs;
      const redisKey = `rate_limit:${req.key}:${windowStart}`;
      
      keys.push(redisKey);
      args.push(limit.toString(), req.units.toString(), windowMs.toString());
    }

    // Execute the Lua script
    // The script returns [allowed (1 or 0), resetAt (if not allowed)]
    const result = await this.redis.consumeRateLimit(keys.length, keys, ...args);

    if (result[0] === 1) {
      return { allowed: true };
    } else {
      return { allowed: false, resetAt: result[1] };
    }
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  #registerCommands(): void {
    // Lua script for atomic multi-key rate limiting
    // KEYS: array of rate limit keys for the current window
    // ARGV: [now, limit1, units1, windowMs1, limit2, units2, windowMs2, ...]
    this.redis.defineCommand("consumeRateLimit", {
      lua: `
local numRequests = #KEYS
local now = tonumber(ARGV[1])

-- Step 1: Check all limits
for i = 1, numRequests do
  local key = KEYS[i]
  local limit = tonumber(ARGV[(i - 1) * 3 + 2])
  local units = tonumber(ARGV[(i - 1) * 3 + 3])
  local windowMs = tonumber(ARGV[(i - 1) * 3 + 4])
  
  local current = tonumber(redis.call('GET', key) or "0")
  
  if current + units > limit then
    local ttl = redis.call('PTTL', key)
    local resetAt
    if ttl > 0 then
      resetAt = now + ttl
    else
      resetAt = now + windowMs
    end
    return {0, resetAt}
  end
end

-- Step 2: Consume units for all keys
for i = 1, numRequests do
  local key = KEYS[i]
  local units = tonumber(ARGV[(i - 1) * 3 + 3])
  local windowMs = tonumber(ARGV[(i - 1) * 3 + 4])
  
  local current = redis.call('INCRBY', key, units)
  if current == units then
    redis.call('PEXPIRE', key, windowMs)
  end
end

return {1, 0}
      `,
    });
  }
}

declare module "@internal/redis" {
  interface RedisCommander<Context> {
    consumeRateLimit(
      numKeys: number,
      keys: string[],
      ...args: string[]
    ): Promise<[number, number]>;
  }
}
