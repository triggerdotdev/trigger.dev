import { redisTest } from "@internal/testcontainers";
import { Ratelimit } from "@upstash/ratelimit";
import Redis from "ioredis";
import { expect } from "vitest";
import { RateLimiter } from "~/services/rateLimiterCore.server";

// Catches: treating a zero timeout as immediate fail-open instead of waiting for Redis to deny a request.
redisTest("zero timeout preserves rejection while Redis is slow", async ({ redisOptions }) => {
  const redis = new Redis(redisOptions);
  try {
    const limiter = new RateLimiter({
      redis: { ...redisOptions, tlsDisabled: true },
      keyPrefix: "zero-timeout-test",
      limiter: Ratelimit.slidingWindow(1, "1 m"),
      timeoutMs: 0,
      ephemeralCache: false,
      logFailure: false,
    });
    const redisPauseMs = 100;
    await redis.client("PAUSE", redisPauseMs);
    const requestCost = 2;
    expect((await limiter.limit("request", requestCost)).success).toBe(false);
  } finally {
    redis.disconnect();
  }
});
