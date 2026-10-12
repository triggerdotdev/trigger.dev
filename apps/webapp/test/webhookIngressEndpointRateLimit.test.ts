import { redisTest } from "@internal/testcontainers";
import { type RedisOptions } from "ioredis";
import { describe, expect, vi } from "vitest";
import { createWebhookIngressRateLimiter } from "../app/services/webhookIngressRateLimit.server.js";

vi.setConfig({ testTimeout: 60_000 });

function limiterFor(redisOptions: RedisOptions) {
  return createWebhookIngressRateLimiter({
    host: redisOptions.host,
    port: redisOptions.port,
    username: redisOptions.username,
    password: redisOptions.password,
    tlsDisabled: true,
  });
}

describe("webhookIngressRateLimiter", () => {
  redisTest("applies each endpoint's own limit", async ({ redisOptions }) => {
    const limiter = limiterFor(redisOptions);
    const small = { tokens: 2, windowSeconds: 3600 };
    const large = { tokens: 5, windowSeconds: 3600 };

    for (let i = 0; i < 2; i++) expect((await limiter.limit("ep_small", small)).success).toBe(true);
    expect((await limiter.limit("ep_small", small)).success).toBe(false);

    for (let i = 0; i < 5; i++) expect((await limiter.limit("ep_large", large)).success).toBe(true);
    expect((await limiter.limit("ep_large", large)).success).toBe(false);
  });

  redisTest("a raised limit applies to the window already counted", async ({ redisOptions }) => {
    const limiter = limiterFor(redisOptions);
    const before = { tokens: 2, windowSeconds: 3600 };
    const after = { tokens: 5, windowSeconds: 3600 };

    for (let i = 0; i < 2; i++) await limiter.limit("ep_raised", before);
    const blocked = await limiter.limit("ep_raised", before);
    expect(blocked.success).toBe(false);
    expect(blocked.reset).toBeGreaterThan(Date.now());

    expect((await limiter.limit("ep_raised", after)).success).toBe(true);
    expect((await limiter.limit("ep_raised", after)).success).toBe(true);
    expect((await limiter.limit("ep_raised", after)).success).toBe(false);
  });
});
