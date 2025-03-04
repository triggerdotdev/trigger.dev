// GCRARateLimiter.test.ts
import { redisTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { GCRARateLimiter } from "../app/v3/GCRARateLimiter.server.js"; // adjust the import as needed
import Redis from "ioredis";

// Extend the timeout to 30 seconds (as in your redis tests)
vi.setConfig({ testTimeout: 30_000 });

describe("GCRARateLimiter", () => {
  redisTest("should allow a single request when under the rate limit", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);

    const limiter = new GCRARateLimiter({
      redis,
      emissionInterval: 1000, // 1 request per second on average
      burstTolerance: 3000, // Allows a burst of 4 requests (3 * 1000 + 1)
      keyPrefix: "test:ratelimit:",
    });

    const result = await limiter.check("user:1");
    expect(result.allowed).toBe(true);
  });

  redisTest(
    "should allow bursts up to the configured limit and then reject further requests",
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);

      const limiter = new GCRARateLimiter({
        redis,
        emissionInterval: 1000,
        burstTolerance: 3000, // With an emission interval of 1000ms, burstTolerance of 3000ms allows 4 rapid requests.
        keyPrefix: "test:ratelimit:",
      });

      // Call 4 times in rapid succession (all should be allowed)
      const results = await Promise.all([
        limiter.check("user:burst"),
        limiter.check("user:burst"),
        limiter.check("user:burst"),
        limiter.check("user:burst"),
      ]);
      results.forEach((result) => expect(result.allowed).toBe(true));

      // The 5th call should be rejected.
      const fifthResult = await limiter.check("user:burst");
      expect(fifthResult.allowed).toBe(false);
      expect(fifthResult.retryAfter).toBeGreaterThan(0);
    }
  );

  redisTest(
    "should allow a request after the required waiting period",
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);

      const limiter = new GCRARateLimiter({
        redis,
        emissionInterval: 1000,
        burstTolerance: 3000,
        keyPrefix: "test:ratelimit:",
      });

      // Exhaust burst capacity with 4 rapid calls.
      await limiter.check("user:wait");
      await limiter.check("user:wait");
      await limiter.check("user:wait");
      await limiter.check("user:wait");

      // The 5th call should be rejected.
      const rejection = await limiter.check("user:wait");
      expect(rejection.allowed).toBe(false);
      expect(rejection.retryAfter).toBeGreaterThan(0);

      // Wait for the period specified in retryAfter (plus a small buffer)
      await new Promise((resolve) => setTimeout(resolve, rejection.retryAfter! + 50));

      // Now the next call should be allowed.
      const allowedAfterWait = await limiter.check("user:wait");
      expect(allowedAfterWait.allowed).toBe(true);
    }
  );

  redisTest(
    "should rate limit independently for different identifiers",
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);

      const limiter = new GCRARateLimiter({
        redis,
        emissionInterval: 1000,
        burstTolerance: 3000,
        keyPrefix: "test:ratelimit:",
      });

      // For "user:independent", exhaust burst capacity.
      await limiter.check("user:independent");
      await limiter.check("user:independent");
      await limiter.check("user:independent");
      await limiter.check("user:independent");
      const rejected = await limiter.check("user:independent");
      expect(rejected.allowed).toBe(false);

      // A different identifier should start fresh.
      const fresh = await limiter.check("user:different");
      expect(fresh.allowed).toBe(true);
    }
  );

  redisTest("should gradually reduce retryAfter with time", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);

    const limiter = new GCRARateLimiter({
      redis,
      emissionInterval: 1000,
      burstTolerance: 3000,
      keyPrefix: "test:ratelimit:",
    });

    // Exhaust the burst capacity.
    await limiter.check("user:gradual");
    await limiter.check("user:gradual");
    await limiter.check("user:gradual");
    await limiter.check("user:gradual");

    const firstRejection = await limiter.check("user:gradual");
    expect(firstRejection.allowed).toBe(false);
    const firstRetry = firstRejection.retryAfter!;

    // Wait 500ms, then perform another check.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const secondRejection = await limiter.check("user:gradual");
    // It should still be rejected but with a smaller wait time.
    expect(secondRejection.allowed).toBe(false);
    const secondRetry = secondRejection.retryAfter!;
    expect(secondRetry).toBeLessThan(firstRetry);
  });

  redisTest("should expire the key after the TTL", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);

    // For this test, override keyExpiration to a short value.
    const keyExpiration = 1500; // 1.5 seconds TTL
    const limiter = new GCRARateLimiter({
      redis,
      emissionInterval: 100,
      burstTolerance: 300, // These values are arbitrary for this test.
      keyPrefix: "test:expire:",
      keyExpiration,
    });
    const identifier = "user:expire";

    // Make a call to set the key.
    const result = await limiter.check(identifier);
    expect(result.allowed).toBe(true);

    // Immediately verify the key exists.
    const key = `test:expire:${identifier}`;
    let stored = await redis.get(key);
    expect(stored).not.toBeNull();

    // Wait for longer than keyExpiration.
    await new Promise((resolve) => setTimeout(resolve, keyExpiration + 200));
    stored = await redis.get(key);
    expect(stored).toBeNull();
  });

  redisTest("should not share state across different key prefixes", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);

    const limiter1 = new GCRARateLimiter({
      redis,
      emissionInterval: 1000,
      burstTolerance: 3000,
      keyPrefix: "test:ratelimit1:",
    });
    const limiter2 = new GCRARateLimiter({
      redis,
      emissionInterval: 1000,
      burstTolerance: 3000,
      keyPrefix: "test:ratelimit2:",
    });

    // Exhaust the burst capacity for a given identifier in limiter1.
    await limiter1.check("user:shared");
    await limiter1.check("user:shared");
    await limiter1.check("user:shared");
    await limiter1.check("user:shared");
    const rejection1 = await limiter1.check("user:shared");
    expect(rejection1.allowed).toBe(false);

    // With a different key prefix, the same identifier should be fresh.
    const result2 = await limiter2.check("user:shared");
    expect(result2.allowed).toBe(true);
  });

  redisTest(
    "should increment TAT correctly on sequential allowed requests",
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);

      const limiter = new GCRARateLimiter({
        redis,
        emissionInterval: 1000,
        burstTolerance: 3000,
        keyPrefix: "test:ratelimit:",
      });

      // The first request should be allowed.
      const r1 = await limiter.check("user:sequential");
      expect(r1.allowed).toBe(true);

      // Wait a bit longer than the emission interval.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const r2 = await limiter.check("user:sequential");
      expect(r2.allowed).toBe(true);
    }
  );

  redisTest("should throw an error if redis command fails", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);

    const limiter = new GCRARateLimiter({
      redis,
      emissionInterval: 1000,
      burstTolerance: 3000,
      keyPrefix: "test:ratelimit:",
    });

    // Stub redis.gcra to simulate a failure.
    // @ts-expect-error
    const originalGcra = redis.gcra;
    // @ts-ignore
    redis.gcra = vi.fn(() => {
      throw new Error("Simulated Redis error");
    });

    await expect(limiter.check("user:error")).rejects.toThrow("Simulated Redis error");

    // Restore the original command.
    // @ts-expect-error
    redis.gcra = originalGcra;
  });
});
