import { redisTest } from "@internal/testcontainers";
import { type RedisOptions } from "ioredis";
import { describe, expect, vi } from "vitest";
import { createWebhookIngressIpRateLimiter } from "../app/services/webhookIngressIpRateLimit.server.js";

vi.setConfig({ testTimeout: 60_000 });

const TOKENS = 3;

function gateFor(redisOptions: RedisOptions) {
  return createWebhookIngressIpRateLimiter({
    tokens: TOKENS,
    window: "1h",
    redis: {
      host: redisOptions.host,
      port: redisOptions.port,
      username: redisOptions.username,
      password: redisOptions.password,
      tlsDisabled: true,
    },
  });
}

describe("webhookIngressIpRateLimiter", () => {
  redisTest("limits one IP and reports when to retry", async ({ redisOptions }) => {
    const gate = gateFor(redisOptions);
    for (let i = 0; i < TOKENS; i++) expect((await gate.limit("10.0.0.1")).success).toBe(true);
    const blocked = await gate.limit("10.0.0.1");
    expect(blocked.success).toBe(false);
    if (!blocked.success) {
      expect(blocked.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(3600);
    }
  });

  redisTest(
    "remembers an IP that used up its budget until the window resets",
    async ({ redisOptions }) => {
      const gate = gateFor(redisOptions);
      expect(gate.blockedFor("10.0.0.5")).toBeUndefined();
      for (let i = 0; i < TOKENS; i++) await gate.limit("10.0.0.5");
      expect(gate.blockedFor("10.0.0.5")).toBeUndefined();
      await gate.limit("10.0.0.5");
      const seconds = gate.blockedFor("10.0.0.5");
      expect(seconds).toBeGreaterThanOrEqual(1);
      expect(seconds).toBeLessThanOrEqual(3600);
      expect(gate.blockedFor("10.0.0.6")).toBeUndefined();
      expect(gate.blockedFor(null)).toBeUndefined();
    }
  );

  redisTest("gives each blocked IP its own lookup budget", async ({ redisOptions }) => {
    const gate = createWebhookIngressIpRateLimiter({
      tokens: TOKENS,
      window: "1h",
      blockedLookupsPerSecond: 5,
      redis: {
        host: redisOptions.host,
        port: redisOptions.port,
        username: redisOptions.username,
        password: redisOptions.password,
        tlsDisabled: true,
      },
    });
    const attacker = Array.from({ length: 8 }, () => gate.takeBlockedLookup("10.0.0.7"));
    expect(attacker.filter(Boolean)).toHaveLength(5);
    expect(attacker.slice(5)).toEqual([false, false, false]);
    expect(gate.takeBlockedLookup("10.0.0.8")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(gate.takeBlockedLookup("10.0.0.7")).toBe(true);
  });

  redisTest("counts each IP on its own", async ({ redisOptions }) => {
    const gate = gateFor(redisOptions);
    for (let i = 0; i < TOKENS + 2; i++) await gate.limit("10.0.0.2");
    expect((await gate.limit("10.0.0.3")).success).toBe(true);
  });

  redisTest("doesn't limit a request with no client IP", async ({ redisOptions }) => {
    const gate = gateFor(redisOptions);
    for (let i = 0; i < TOKENS + 2; i++) expect((await gate.limit(null)).success).toBe(true);
  });
});
