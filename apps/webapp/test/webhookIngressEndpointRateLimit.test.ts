import { redisTest } from "@internal/testcontainers";
import { type RedisOptions } from "ioredis";
import { describe, expect, vi } from "vitest";
import {
  chargeWebhookIngressBody,
  createWebhookIngressRateLimiter,
  webhookIngressTokenCost,
} from "../app/services/webhookIngressRateLimit.server.js";

vi.setConfig({ testTimeout: 60_000 });

function limiterFor(redisOptions: RedisOptions, keyPrefix?: string) {
  return createWebhookIngressRateLimiter(
    {
      host: redisOptions.host,
      port: redisOptions.port,
      username: redisOptions.username,
      password: redisOptions.password,
      tlsDisabled: true,
    },
    keyPrefix
  );
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

  redisTest(
    "an environment's limit counts one token per started 64 KiB of body",
    async ({ redisOptions }) => {
      const limiter = limiterFor(redisOptions, "webhook-ingress-env");
      const limit = { tokens: 10, windowSeconds: 3600 };

      expect(webhookIngressTokenCost(0)).toBe(1);
      expect(webhookIngressTokenCost(64 * 1024)).toBe(1);
      expect(webhookIngressTokenCost(64 * 1024 + 1)).toBe(2);
      expect(webhookIngressTokenCost(1024 * 1024)).toBe(16);

      expect((await limiter.limit("env_a", limit, webhookIngressTokenCost(500_000))).success).toBe(
        true
      );
      expect((await limiter.limit("env_a", limit, 2)).success).toBe(true);
      expect((await limiter.limit("env_a", limit)).success).toBe(false);
      expect((await limiter.limit("env_b", limit, 10)).success).toBe(true);
    }
  );

  redisTest(
    "an environment's limit and an endpoint's limit count apart",
    async ({ redisOptions }) => {
      const endpoints = limiterFor(redisOptions);
      const environments = limiterFor(redisOptions, "webhook-ingress-env");
      const limit = { tokens: 1, windowSeconds: 3600 };

      expect((await endpoints.limit("same_id", limit)).success).toBe(true);
      expect((await environments.limit("same_id", limit)).success).toBe(true);
      expect((await endpoints.limit("same_id", limit)).success).toBe(false);
    }
  );

  redisTest(
    "a body read past the cap still uses up the environment's budget",
    async ({ redisOptions }) => {
      const limiter = limiterFor(redisOptions, "webhook-ingress-env");
      const environment = { id: "env_oversized", limit: { tokens: 40, windowSeconds: 3600 } };
      const cap = 1024 * 1024;

      for (let i = 0; i < 2; i++) {
        expect((await limiter.limit(environment.id, environment.limit)).success).toBe(true);
        expect((await chargeWebhookIngressBody(limiter, environment, cap + 1)).success).toBe(true);
      }
      expect((await limiter.limit(environment.id, environment.limit)).success).toBe(true);
      expect((await chargeWebhookIngressBody(limiter, environment, cap + 1)).success).toBe(false);
      expect((await limiter.limit(environment.id, environment.limit)).success).toBe(false);
    }
  );

  redisTest("a small body costs nothing past admission", async ({ redisOptions }) => {
    const limiter = limiterFor(redisOptions, "webhook-ingress-env");
    const environment = { id: "env_small", limit: { tokens: 1, windowSeconds: 3600 } };

    expect((await limiter.limit(environment.id, environment.limit)).success).toBe(true);
    expect((await chargeWebhookIngressBody(limiter, environment, 10 * 1024)).success).toBe(true);
  });
});
