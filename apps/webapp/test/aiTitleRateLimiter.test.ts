import { redisTest } from "@internal/testcontainers";
import { type RedisOptions } from "ioredis";
import { describe, expect, vi } from "vitest";
import { type RedisWithClusterOptions } from "../app/redis.server.js";
import {
  AI_TITLE_RATE_LIMIT_ATTEMPTS,
  createAITitleRateLimiter,
} from "../app/v3/services/aiTitleRateLimiter.server.js";

vi.setConfig({ testTimeout: 60_000 });

// Plaintext container: without tlsDisabled the client attempts TLS, the
// connection fails, and @upstash/ratelimit fails open (allowing everything).
const toRedisOptions = (o: RedisOptions): RedisWithClusterOptions => ({
  host: o.host,
  port: o.port,
  username: o.username,
  password: o.password,
  tlsDisabled: true,
});

let seq = 0;
const userKey = (label: string) => `user:${label}-${seq++}`;

// The query ai-title endpoint isn't covered by the global apiRateLimiter, so
// this per-user limiter is the only thing bounding it.
describe("aiTitleRateLimiter", () => {
  redisTest("allows up to the limit then blocks further attempts", async ({ redisOptions }) => {
    const limiter = createAITitleRateLimiter(toRedisOptions(redisOptions));
    const key = userKey("loop");

    for (let i = 0; i < AI_TITLE_RATE_LIMIT_ATTEMPTS; i++) {
      const r = await limiter.limit(key);
      expect(r.success).toBe(true);
    }

    const blocked = await limiter.limit(key);
    expect(blocked.success).toBe(false);
  });

  redisTest("scopes the limit per user", async ({ redisOptions }) => {
    const limiter = createAITitleRateLimiter(toRedisOptions(redisOptions));
    const victim = userKey("victim");
    const bystander = userKey("bystander");

    for (let i = 0; i < AI_TITLE_RATE_LIMIT_ATTEMPTS; i++) {
      await limiter.limit(victim);
    }
    expect((await limiter.limit(victim)).success).toBe(false);

    // A different user is unaffected.
    expect((await limiter.limit(bystander)).success).toBe(true);
  });
});
