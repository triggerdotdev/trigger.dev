import { redisTest } from "@internal/testcontainers";
import { beforeEach, describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 30_000 });

import type { Express } from "express";
import express from "express";
import request from "supertest";
import { authorizationRateLimitMiddleware } from "../app/services/authorizationRateLimitMiddleware.server.js";

const exhaustedLimiter = {
  type: "tokenBucket",
  refillRate: 1,
  interval: "1m",
  maxTokens: 1,
} as const;

describe("authorizationRateLimitMiddleware bypass", () => {
  let app: Express;

  beforeEach(() => {
    app = express();
  });

  redisTest("lets a bypassed request through an exhausted limit", async ({ redisOptions }) => {
    const rateLimitMiddleware = authorizationRateLimitMiddleware({
      redis: { ...redisOptions, tlsDisabled: true },
      keyPrefix: "test-bypass-allowed",
      defaultLimiter: exhaustedLimiter,
      pathMatchers: [/^\/api/],
      bypass: async (req) => req.path === "/api/granted",
    });

    app.use(rateLimitMiddleware);
    app.get("/api/granted", (req, res) => res.status(200).json({ message: "Granted" }));
    app.get("/api/limited", (req, res) => res.status(200).json({ message: "Limited" }));

    await request(app).get("/api/limited").set("Authorization", "Bearer test-token");
    const limited = await request(app)
      .get("/api/limited")
      .set("Authorization", "Bearer test-token");
    expect(limited.status).toBe(429);

    const granted = await request(app)
      .get("/api/granted")
      .set("Authorization", "Bearer test-token");

    expect(granted.status).toBe(200);
    expect(granted.body).toEqual({ message: "Granted" });
  });

  redisTest("falls back to the limiter when the bypass declines", async ({ redisOptions }) => {
    const rateLimitMiddleware = authorizationRateLimitMiddleware({
      redis: { ...redisOptions, tlsDisabled: true },
      keyPrefix: "test-bypass-declined",
      defaultLimiter: exhaustedLimiter,
      pathMatchers: [/^\/api/],
      bypass: async () => false,
    });

    app.use(rateLimitMiddleware);
    app.get("/api/test", (req, res) => res.status(200).json({ message: "Success" }));

    await request(app).get("/api/test").set("Authorization", "Bearer declined");
    const response = await request(app).get("/api/test").set("Authorization", "Bearer declined");

    expect(response.status).toBe(429);
  });

  redisTest("does not let the bypass skip authentication", async ({ redisOptions }) => {
    let bypassCalled = false;

    const rateLimitMiddleware = authorizationRateLimitMiddleware({
      redis: { ...redisOptions, tlsDisabled: true },
      keyPrefix: "test-bypass-unauthenticated",
      defaultLimiter: exhaustedLimiter,
      pathMatchers: [/^\/api/],
      bypass: async () => {
        bypassCalled = true;
        return true;
      },
    });

    app.use(rateLimitMiddleware);
    app.get("/api/test", (req, res) => res.status(200).json({ message: "Success" }));

    const response = await request(app).get("/api/test");

    expect(response.status).toBe(401);
    expect(bypassCalled).toBe(false);
  });
});
