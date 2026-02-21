import type { Redis } from "@internal/redis";

/**
 * Configuration for queue rate limiting (input format).
 */
export interface QueueRateLimitConfig {
  /** Maximum number of requests allowed within the period */
  limit: number;
  /** Time period in milliseconds */
  periodMs: number;
  /** Optional burst capacity (defaults to 1) */
  burst?: number;
}

/**
 * Stored configuration for queue rate limiting (includes pre-calculated GCRA params).
 * This is what gets stored in Redis and read by the Lua dequeue script.
 */
export interface StoredQueueRateLimitConfig extends QueueRateLimitConfig, GCRAParams {}

/**
 * GCRA parameters calculated from QueueRateLimitConfig.
 * These are stored in Redis for use by the Lua dequeue script.
 */
export interface GCRAParams {
  /** The minimum interval between requests in milliseconds */
  emissionInterval: number;
  /** The burst tolerance in milliseconds */
  burstTolerance: number;
  /** Key expiration in milliseconds */
  keyExpiration: number;
}

/**
 * Options for configuring the RateLimiter.
 */
export interface GCRARateLimiterOptions {
  /** An instance of Redis. */
  redis: Redis;
  /**
   * A string prefix to namespace keys in Redis.
   * Defaults to "ratelimit:".
   */
  keyPrefix?: string;
  /**
   * The minimum interval between requests (the emission interval) in milliseconds.
   * For example, 1000 ms for one request per second.
   */
  emissionInterval: number;
  /**
   * The burst tolerance in milliseconds. This represents how much "credit" can be
   * accumulated to allow short bursts beyond the average rate.
   * For example, if you want to allow 3 requests in a burst with an emission interval of 1000 ms,
   * you might set this to 3000.
   */
  burstTolerance: number;
  /**
   * Expiration for the Redis key in milliseconds.
   * Defaults to the larger of 60 seconds or (emissionInterval + burstTolerance).
   */
  keyExpiration?: number;
}

/**
 * The result of a rate limit check.
 */
export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /**
   * If not allowed, this is the number of milliseconds the caller should wait
   * before retrying.
   */
  retryAfter?: number;
}

/**
 * Parse a duration string (e.g., "1s", "100ms", "5m", "1h", "1d") to milliseconds.
 * @throws Error if the duration string is invalid
 */
export function parseDurationToMs(duration: string): number {
  const match = duration.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);

  if (!match) {
    throw new Error(
      `Invalid duration string: "${duration}". Expected format: number + unit (ms, s, m, h, d)`
    );
  }

  const [, value, unit] = match;
  const numValue = parseFloat(value);

  switch (unit) {
    case "ms":
      return Math.round(numValue);
    case "s":
      return Math.round(numValue * 1000);
    case "m":
      return Math.round(numValue * 60 * 1000);
    case "h":
      return Math.round(numValue * 60 * 60 * 1000);
    case "d":
      return Math.round(numValue * 24 * 60 * 60 * 1000);
    default:
      throw new Error(`Unknown duration unit: ${unit}`);
  }
}

/**
 * Convert a QueueRateLimitConfig to GCRA parameters.
 *
 * @example
 * // 10 requests per minute with burst of 3
 * configToGCRAParams({ limit: 10, periodMs: 60000, burst: 3 })
 * // => { emissionInterval: 6000, burstTolerance: 12000, keyExpiration: 60000 }
 */
export function configToGCRAParams(config: QueueRateLimitConfig): GCRAParams {
  const emissionInterval = Math.ceil(config.periodMs / config.limit);
  const burst = config.burst ?? 1;
  // burst-1 because GCRA allows 1 request immediately, then burst-1 more within tolerance
  const burstTolerance = (burst - 1) * emissionInterval;
  const keyExpiration = Math.max(60_000, emissionInterval + burstTolerance);
  return { emissionInterval, burstTolerance, keyExpiration };
}

/**
 * A rate limiter using Redis and the Generic Cell Rate Algorithm (GCRA).
 *
 * The GCRA is implemented using a Lua script that runs atomically in Redis.
 *
 * When a request comes in, the algorithm:
 *  - Retrieves the current "Theoretical Arrival Time" (TAT) from Redis (or initializes it if missing).
 *  - If the current time is greater than or equal to the TAT, the request is allowed and the TAT is updated to now + emissionInterval.
 *  - Otherwise, if the current time plus the burst tolerance is at least the TAT, the request is allowed and the TAT is incremented.
 *  - If neither condition is met, the request is rejected and a Retry-After value is returned.
 */
export class GCRARateLimiter {
  private redis: Redis;
  private keyPrefix: string;
  private emissionInterval: number;
  private burstTolerance: number;
  private keyExpiration: number;

  constructor(options: GCRARateLimiterOptions) {
    this.redis = options.redis;
    this.keyPrefix = options.keyPrefix || "gcra:ratelimit:";
    this.emissionInterval = options.emissionInterval;
    this.burstTolerance = options.burstTolerance;
    // Default expiration: at least 60 seconds or the sum of emissionInterval and burstTolerance
    this.keyExpiration =
      options.keyExpiration || Math.max(60_000, this.emissionInterval + this.burstTolerance);

    // Define a custom Redis command 'gcra' that implements the GCRA algorithm.
    // Using defineCommand ensures the Lua script is loaded once and run atomically.
    this.redis.defineCommand("gcra", {
      numberOfKeys: 1,
      lua: `
--[[
  GCRA Lua script
  KEYS[1]         - The rate limit key (e.g. "ratelimit:<identifier>")
  ARGV[1]         - Current time in ms (number)
  ARGV[2]         - Emission interval in ms (number)
  ARGV[3]         - Burst tolerance in ms (number)
  ARGV[4]         - Key expiration in ms (number)
  
  Returns: { allowedFlag, value }
    allowedFlag: 1 if allowed, 0 if rate-limited.
    value: 0 when allowed; if not allowed, the number of ms to wait.
]]--

local key = KEYS[1]
local now = tonumber(ARGV[1])
local emission_interval = tonumber(ARGV[2])
local burst_tolerance = tonumber(ARGV[3])
local expire = tonumber(ARGV[4])

-- Get the stored Theoretical Arrival Time (TAT) or default to 0.
local tat = tonumber(redis.call("GET", key) or 0)
if tat == 0 then
  tat = now
end

local allowed, new_tat, retry_after

if now >= tat then
  -- No delay: request is on schedule.
  new_tat = now + emission_interval
  allowed = true
elseif (now + burst_tolerance) >= tat then
  -- Within burst capacity: allow request.
  new_tat = tat + emission_interval
  allowed = true
else
  -- Request exceeds the allowed burst; calculate wait time.
  allowed = false
  retry_after = tat - (now + burst_tolerance)
end

if allowed then
  redis.call("SET", key, new_tat, "PX", expire)
  return {1, 0}
else
  return {0, retry_after}
end
`,
    });
  }

  /**
   * Checks whether a request associated with the given identifier is allowed.
   *
   * @param identifier A unique string identifying the subject of rate limiting (e.g. user ID, IP address, or domain).
   * @returns A promise that resolves to a RateLimitResult.
   *
   * @example
   * const result = await rateLimiter.check('user:12345');
   * if (!result.allowed) {
   *   // Tell the client to retry after result.retryAfter milliseconds.
   * }
   */
  async check(identifier: string): Promise<RateLimitResult> {
    const key = `${this.keyPrefix}${identifier}`;
    const now = Date.now();

    try {
      // Call the custom 'gcra' command.
      // The script returns an array: [allowedFlag, value]
      //   - allowedFlag: 1 if allowed; 0 if rejected.
      //   - value: 0 when allowed; if rejected, the number of ms to wait before retrying.
      const result: [number, number] = await (this.redis as any).gcra(
        key,
        now,
        this.emissionInterval,
        this.burstTolerance,
        this.keyExpiration
      );
      const allowed = result[0] === 1;
      if (allowed) {
        return { allowed: true };
      } else {
        return { allowed: false, retryAfter: result[1] };
      }
    } catch (error) {
      // In a production system you might log the error and either
      // allow the request (fail open) or deny it (fail closed).
      // Here we choose to propagate the error.
      throw error;
    }
  }
}
