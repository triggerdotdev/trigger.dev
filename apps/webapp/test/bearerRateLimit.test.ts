import { redisTest } from "@internal/testcontainers";
import express from "express";
import request from "supertest";
import { expect, vi } from "vitest";
import { authorizationRateLimitMiddleware } from "~/services/authorizationRateLimitMiddleware.server";

vi.setConfig({ testTimeout: 30_000 });

// Catches: whitespace-equivalent bearer credentials receiving fresh rate-limit buckets.
redisTest(
  "shares a bucket across bearer credential whitespace variants",
  async ({ redisOptions }) => {
    const app = express();
    app.use(
      authorizationRateLimitMiddleware({
        redis: { ...redisOptions, tlsDisabled: true },
        keyPrefix: "bearer-whitespace-test",
        defaultLimiter: { type: "tokenBucket", refillRate: 1, interval: "1m", maxTokens: 1 },
        pathMatchers: ["/api/test"],
        log: { requests: false, rejections: false },
      })
    );
    app.get("/api/test", (_req, res) => res.sendStatus(200));

    const send = (authorization: string) =>
      request(app).get("/api/test").set("Authorization", authorization);

    expect((await send("Bearer test-token")).status).toBe(200);
    expect((await send("Bearer  test-token")).status).toBe(429);
    expect((await send("Bearer \t test-token  ")).status).toBe(429);
    expect((await send("Bearer different-token")).status).toBe(200);
  }
);
