import { z } from "zod";
import { Ratelimit } from "@upstash/ratelimit";
import type { Duration, RateLimiterRedisClient } from "~/services/rateLimiter.server";
import { logger } from "~/services/logger.server";

/**
 * Schema for per-event rate limit configuration stored in EventDefinition.rateLimit.
 *
 * Example: { "limit": 100, "window": "1m" }
 */
export const EventRateLimitConfig = z.object({
  /** Maximum number of publishes allowed in the window */
  limit: z.number().int().positive(),
  /** Time window — e.g. "1m", "10s", "1h" */
  window: z.string().regex(/^\d+[smh]$/, 'Must be a duration like "10s", "1m", "1h"'),
});

export type EventRateLimitConfig = z.infer<typeof EventRateLimitConfig>;

/** Result of a rate limit check */
export interface EventRateLimitResult {
  allowed: boolean;
  limit?: number;
  remaining?: number;
  /** Milliseconds until the window resets */
  retryAfter?: number;
}

/** Interface for pluggable rate limit backends */
export interface EventRateLimitChecker {
  check(key: string, config: EventRateLimitConfig): Promise<EventRateLimitResult>;
}

/**
 * Parse the rateLimit JSON from the database. Returns undefined if not set or invalid.
 */
export function parseEventRateLimitConfig(
  rawConfig: unknown
): EventRateLimitConfig | undefined {
  if (!rawConfig) return undefined;
  const result = EventRateLimitConfig.safeParse(rawConfig);
  if (!result.success) {
    logger.warn("Invalid event rate limit config", {
      config: rawConfig,
      error: result.error.message,
    });
    return undefined;
  }
  return result.data;
}

/** Convert window string (e.g. "1m", "30s", "2h") to milliseconds */
export function windowToMs(window: string): number {
  const match = window.match(/^(\d+)([smh])$/);
  if (!match) throw new Error(`Invalid window format: ${window}`);

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  switch (unit) {
    case "s":
      return value * 1000;
    case "m":
      return value * 60 * 1000;
    case "h":
      return value * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown time unit: ${unit}`);
  }
}

/**
 * In-memory sliding window rate limiter.
 * Suitable for single-process use and testing.
 * For production, use a Redis-backed implementation.
 */
export class InMemoryEventRateLimitChecker implements EventRateLimitChecker {
  private windows = new Map<string, number[]>();

  async check(key: string, config: EventRateLimitConfig): Promise<EventRateLimitResult> {
    const now = Date.now();
    const windowMs = windowToMs(config.window);

    // Get or create the timestamp array for this key
    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Remove expired entries
    const cutoff = now - windowMs;
    while (timestamps.length > 0 && timestamps[0]! < cutoff) {
      timestamps.shift();
    }

    if (timestamps.length < config.limit) {
      timestamps.push(now);
      return {
        allowed: true,
        limit: config.limit,
        remaining: config.limit - timestamps.length,
      };
    }

    // Rate limited — calculate retry after
    const oldestInWindow = timestamps[0]!;
    const retryAfter = oldestInWindow + windowMs - now;

    return {
      allowed: false,
      limit: config.limit,
      remaining: 0,
      retryAfter: Math.max(0, retryAfter),
    };
  }

  /** Reset all state (useful for testing) */
  reset() {
    this.windows.clear();
  }
}

/**
 * Convert an event rate limit window string (e.g. "30s", "1m", "2h") to an
 * Upstash Duration string (e.g. "30 s", "1 m", "2 h").
 */
function windowToUpstashDuration(window: string): Duration {
  const match = window.match(/^(\d+)([smh])$/);
  if (!match) throw new Error(`Invalid window format: ${window}`);

  const value = match[1]!;
  const unit = match[2]!;

  const unitMap: Record<string, string> = { s: "s", m: "m", h: "h" };
  return `${value} ${unitMap[unit]}` as Duration;
}

/**
 * Redis-backed sliding window rate limiter using @upstash/ratelimit.
 * Survives process restarts and works across multiple instances.
 */
export class RedisEventRateLimitChecker implements EventRateLimitChecker {
  private limiters = new Map<string, Ratelimit>();

  constructor(private readonly redisClient: RateLimiterRedisClient) {}

  async check(key: string, config: EventRateLimitConfig): Promise<EventRateLimitResult> {
    // Get or create a limiter for this specific config (keyed by limit+window)
    const configKey = `${config.limit}:${config.window}`;
    let limiter = this.limiters.get(configKey);

    if (!limiter) {
      limiter = new Ratelimit({
        redis: this.redisClient,
        limiter: Ratelimit.slidingWindow(config.limit, windowToUpstashDuration(config.window)),
        ephemeralCache: new Map(),
        analytics: false,
        prefix: "ratelimit:event-publish",
      });
      this.limiters.set(configKey, limiter);
    }

    const result = await limiter.limit(key);

    if (result.success) {
      return {
        allowed: true,
        limit: result.limit,
        remaining: result.remaining,
      };
    }

    const retryAfter = result.reset - Date.now();

    return {
      allowed: false,
      limit: result.limit,
      remaining: 0,
      retryAfter: Math.max(0, retryAfter),
    };
  }
}
