import { InMemoryEventRateLimitChecker } from "./eventRateLimiter.server";

/**
 * Global singleton for the event publish rate limiter.
 *
 * Uses the in-memory sliding window implementation.
 * For production at scale, this can be swapped for a Redis-backed checker.
 */
export const eventPublishRateLimitChecker = new InMemoryEventRateLimitChecker();
