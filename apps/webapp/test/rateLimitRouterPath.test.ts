import { redisTest } from "@internal/testcontainers";
import express from "express";
import request from "supertest";
import { expect, vi } from "vitest";
import { authorizationRateLimitMiddleware } from "~/services/authorizationRateLimitMiddleware.server";

vi.setConfig({ testTimeout: 30_000 });

// Catches: an encoded or uppercase path (/%61pi, /API) reaching an API route without being
// rate limited, because Remix decodes and case-folds the path before routing.
redisTest(
  "rate limits encoded and uppercase paths against the same bucket",
  async ({ redisOptions }) => {
    const app = express();
    app.use(
      authorizationRateLimitMiddleware({
        redis: { ...redisOptions, tlsDisabled: true },
        keyPrefix: "router-path-test",
        defaultLimiter: { type: "tokenBucket", refillRate: 1, interval: "1m", maxTokens: 1 },
        pathMatchers: [/^\/api/],
        log: { requests: false, rejections: false },
      })
    );
    app.use((_req, res) => res.sendStatus(200));

    const send = (path: string) => request(app).get(path).set("Authorization", "Bearer test-token");

    expect((await send("/api/test")).status).toBe(200);
    for (const path of ["/%61pi/test", "/API/test", "/%41PI/test"]) {
      expect((await send(path)).status, path).toBe(429);
    }
  }
);
