import { redisTest } from "@internal/testcontainers";
import express from "express";
import request from "supertest";
import { expect, vi } from "vitest";
import { authorizationRateLimitMiddleware } from "~/services/authorizationRateLimitMiddleware.server";

vi.setConfig({ testTimeout: 30_000 });

const ALLOWED_IP = "203.0.113.9";
const BLOCKED_IP = "198.51.100.7";

// Catches: requests from outside a key's allowed IPs being charged to its environment's bucket,
// which would let whoever holds a leaked key use up the customer's API rate limit.
redisTest(
  "charges blocked-IP requests to the key's own bucket, not its environment's",
  async ({ redisOptions }) => {
    const app = express();
    app.use(
      authorizationRateLimitMiddleware({
        redis: { ...redisOptions, tlsDisabled: true },
        keyPrefix: "ip-allowlist-test",
        defaultLimiter: { type: "tokenBucket", refillRate: 1, interval: "1m", maxTokens: 100 },
        pathMatchers: [/^\/api/],
        limiterConfigOverride: async () => ({
          identifier: "env_restricted",
          config: { type: "tokenBucket", refillRate: 1, interval: "1m", maxTokens: 2 },
          allowedIpRanges: ["203.0.113.0/24"],
        }),
      })
    );
    app.get("/api/test", (_req, res) => {
      res.status(200).json({ ok: true });
    });

    const send = (ip: string) =>
      request(app)
        .get("/api/test")
        .set("Authorization", "Bearer tr_prod_sk_restricted")
        .set("X-Forwarded-For", ip);

    for (let i = 0; i < 5; i++) {
      const blocked = await send(BLOCKED_IP);
      expect(blocked.status).toBe(200);
      expect(blocked.headers["x-ratelimit-limit"]).toBe("100");
    }

    // The environment's bucket of 2 is untouched by the blocked requests above.
    expect((await send(ALLOWED_IP)).status).toBe(200);
    expect((await send(ALLOWED_IP)).status).toBe(200);
    expect((await send(ALLOWED_IP)).status).toBe(429);
  }
);
