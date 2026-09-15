import { redisTest } from "@internal/testcontainers";
import { type RedisOptions } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { type RedisWithClusterOptions } from "../app/redis.server.js";
import {
  checkMfaRateLimit,
  createMfaRateLimiters,
  MFA_DAILY_ATTEMPTS,
  MFA_PER_MINUTE_ATTEMPTS,
  MfaRateLimitError,
} from "../app/services/mfa/mfaRateLimiter.server.js";

// redisTest spins up a container per test; give startup + the cumulative
// 30-attempt loop room.
vi.setConfig({ testTimeout: 60_000 });

// The container speaks plaintext; without tlsDisabled the client tries TLS,
// the connection fails, and @upstash/ratelimit fails open (allowing every
// attempt). Map the fixture options onto the shape createMfaRateLimiters
// expects, with TLS off.
const toRedisOptions = (redisOptions: RedisOptions): RedisWithClusterOptions => ({
  host: redisOptions.host,
  port: redisOptions.port,
  username: redisOptions.username,
  password: redisOptions.password,
  tlsDisabled: true,
});

// A unique user id per test so sliding-window state never bleeds between
// cases (Redis is shared within a container).
let seq = 0;
const userId = (label: string) => `mfa-${label}-${seq++}`;

describe("checkMfaRateLimit", () => {
  redisTest(
    "allows up to the per-minute cap then blocks the next attempt",
    async ({ redisOptions }) => {
      const limiters = createMfaRateLimiters({ redisOptions: toRedisOptions(redisOptions) });
      const id = userId("per-min");

      // The first MFA_PER_MINUTE_ATTEMPTS (5) succeed.
      for (let i = 0; i < MFA_PER_MINUTE_ATTEMPTS; i++) {
        await expect(checkMfaRateLimit(id, limiters)).resolves.toBeUndefined();
      }

      // The 6th within the same minute is rejected.
      await expect(checkMfaRateLimit(id, limiters)).rejects.toBeInstanceOf(MfaRateLimitError);
    }
  );

  redisTest(
    "caps cumulative attempts at the daily limit even when the per-minute window would allow them",
    async ({ redisOptions }) => {
      // Raise the per-minute cap out of the way so this test isolates the
      // 24h cumulative window.
      const limiters = createMfaRateLimiters({
        redisOptions: toRedisOptions(redisOptions),
        perMinuteAttempts: 100_000,
      });
      const id = userId("daily");

      for (let i = 0; i < MFA_DAILY_ATTEMPTS; i++) {
        await expect(checkMfaRateLimit(id, limiters)).resolves.toBeUndefined();
      }

      await expect(checkMfaRateLimit(id, limiters)).rejects.toBeInstanceOf(MfaRateLimitError);
    }
  );

  redisTest("rate limits are scoped per user id", async ({ redisOptions }) => {
    const limiters = createMfaRateLimiters({ redisOptions: toRedisOptions(redisOptions) });
    const victim = userId("victim");
    const bystander = userId("bystander");

    // Exhaust the per-minute window for the victim.
    for (let i = 0; i < MFA_PER_MINUTE_ATTEMPTS; i++) {
      await checkMfaRateLimit(victim, limiters);
    }
    await expect(checkMfaRateLimit(victim, limiters)).rejects.toBeInstanceOf(MfaRateLimitError);

    // A different user is unaffected.
    await expect(checkMfaRateLimit(bystander, limiters)).resolves.toBeUndefined();
  });

  redisTest("the thrown error carries a positive retry-after", async ({ redisOptions }) => {
    const limiters = createMfaRateLimiters({ redisOptions: toRedisOptions(redisOptions) });
    const id = userId("retry-after");

    for (let i = 0; i < MFA_PER_MINUTE_ATTEMPTS; i++) {
      await checkMfaRateLimit(id, limiters);
    }

    const error = await checkMfaRateLimit(id, limiters).catch((e) => e);
    expect(error).toBeInstanceOf(MfaRateLimitError);
    expect((error as MfaRateLimitError).retryAfter).toBeGreaterThan(0);
  });

  redisTest(
    "the daily cap is checked before the per-minute cap, so an exhausted day blocks the very first attempt of a fresh minute",
    async ({ redisOptions }) => {
      // perMinute high enough that only the daily window can trip.
      const limiters = createMfaRateLimiters({
        redisOptions: toRedisOptions(redisOptions),
        perMinuteAttempts: 100_000,
        dailyAttempts: 3,
      });
      const id = userId("daily-first");

      await checkMfaRateLimit(id, limiters);
      await checkMfaRateLimit(id, limiters);
      await checkMfaRateLimit(id, limiters);

      // Daily budget (3) is spent; the next attempt is rejected even though
      // the per-minute window is nowhere near full.
      await expect(checkMfaRateLimit(id, limiters)).rejects.toBeInstanceOf(MfaRateLimitError);
    }
  );

  it("pins the production policy to the documented values", () => {
    // Guards against a silent loosening of the caps in future edits.
    expect(MFA_PER_MINUTE_ATTEMPTS).toBe(5);
    expect(MFA_DAILY_ATTEMPTS).toBe(30);
  });
});
