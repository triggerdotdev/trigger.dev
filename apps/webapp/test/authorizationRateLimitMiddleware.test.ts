import { redisTest } from "@internal/testcontainers";
import { describe, expect, vi, beforeEach } from "vitest";

vi.setConfig({ testTimeout: 30_000 }); // 30 seconds timeout

// Mock the logger
vi.mock("./logger.server", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import express, { Express } from "express";
import request from "supertest";
import { authorizationRateLimitMiddleware } from "../app/services/authorizationRateLimitMiddleware.server.js";

describe.skipIf(process.env.GITHUB_ACTIONS)("authorizationRateLimitMiddleware", () => {
  let app: Express;

  beforeEach(() => {
    app = express();
  });

  redisTest("should allow requests within the rate limit", async ({ redisOptions }) => {
    const rateLimitMiddleware = authorizationRateLimitMiddleware({
      redis: redisOptions,
      keyPrefix: "test",
      defaultLimiter: {
        type: "tokenBucket",
        refillRate: 10,
        interval: "1m",
        maxTokens: 100,
      },
      pathMatchers: [/^\/api/],
      log: {
        rejections: false,
        requests: false,
      },
    });

    app.use(rateLimitMiddleware);
    app.get("/api/test", (req, res) => {
      res.status(200).json({ message: "Success" });
    });

    const response = await request(app).get("/api/test").set("Authorization", "Bearer test-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "Success" });
    expect(response.headers["x-ratelimit-limit"]).toBeDefined();
    expect(response.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(response.headers["x-ratelimit-reset"]).toBeDefined();
  });

  redisTest("should reject requests without an Authorization header", async ({ redisOptions }) => {
    const rateLimitMiddleware = authorizationRateLimitMiddleware({
      redis: redisOptions,
      keyPrefix: "test",
      defaultLimiter: {
        type: "tokenBucket",
        refillRate: 10,
        interval: "1m",
        maxTokens: 100,
      },
      pathMatchers: [/^\/api/],
    });

    app.use(rateLimitMiddleware);
    app.get("/api/test", (req, res) => {
      res.status(200).json({ message: "Success" });
    });

    const response = await request(app).get("/api/test");

    expect(response.status).toBe(401);
    expect(response.body).toHaveProperty("title", "Unauthorized");
  });

  redisTest("should reject requests that exceed the rate limit", async ({ redisOptions }) => {
    const rateLimitMiddleware = authorizationRateLimitMiddleware({
      redis: redisOptions,
      keyPrefix: "test",
      defaultLimiter: {
        type: "tokenBucket",
        refillRate: 1,
        interval: "1m",
        maxTokens: 1,
      },
      pathMatchers: [/^\/api/],
    });

    app.use(rateLimitMiddleware);
    app.get("/api/test", (req, res) => {
      res.status(200).json({ message: "Success" });
    });

    // First request should succeed
    await request(app).get("/api/test").set("Authorization", "Bearer test-token");

    // Second request should be rate limited
    const response = await request(app).get("/api/test").set("Authorization", "Bearer test-token");

    expect(response.status).toBe(429);
    expect(response.body).toHaveProperty("title", "Rate Limit Exceeded");
  });

  redisTest("should not apply rate limiting to whitelisted paths", async ({ redisOptions }) => {
    const rateLimitMiddleware = authorizationRateLimitMiddleware({
      redis: redisOptions,
      keyPrefix: "test",
      defaultLimiter: {
        type: "tokenBucket",
        refillRate: 10,
        interval: "1m",
        maxTokens: 100,
      },
      pathMatchers: [/^\/api/],
      pathWhiteList: ["/api/whitelist"],
    });

    app.use(rateLimitMiddleware);
    app.get("/api/whitelist", (req, res) => {
      res.status(200).json({ message: "Whitelisted" });
    });

    const response = await request(app)
      .get("/api/whitelist")
      .set("Authorization", "Bearer test-token");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ message: "Whitelisted" });
    expect(response.headers["x-ratelimit-limit"]).toBeUndefined();
  });

  redisTest(
    "should apply different rate limits based on limiterConfigOverride",
    async ({ redisOptions }) => {
      const rateLimitMiddleware = authorizationRateLimitMiddleware({
        redis: redisOptions,
        keyPrefix: "test",
        defaultLimiter: {
          type: "tokenBucket",
          refillRate: 1,
          interval: "1m",
          maxTokens: 1,
        },
        pathMatchers: [/^\/api/],
        limiterConfigOverride: async (authorizationValue) => {
          if (authorizationValue === "Bearer premium-token") {
            return {
              type: "tokenBucket",
              refillRate: 10,
              interval: "1m",
              maxTokens: 100,
            };
          }
          return undefined;
        },
      });

      app.use(rateLimitMiddleware);
      app.get("/api/test", (req, res) => {
        res.status(200).json({ message: "Success" });
      });

      // Regular user should be rate limited after 1 request
      await request(app).get("/api/test").set("Authorization", "Bearer regular-token");
      const regularResponse = await request(app)
        .get("/api/test")
        .set("Authorization", "Bearer regular-token");
      expect(regularResponse.status).toBe(429);

      // Premium user should be able to make multiple requests
      const premiumResponse1 = await request(app)
        .get("/api/test")
        .set("Authorization", "Bearer premium-token");
      expect(premiumResponse1.status).toBe(200);
      const premiumResponse2 = await request(app)
        .get("/api/test")
        .set("Authorization", "Bearer premium-token");
      expect(premiumResponse2.status).toBe(200);
    }
  );

  describe("Advanced Cases", () => {
    // 1. Test different rate limit configurations
    redisTest("should enforce fixed window rate limiting", async ({ redisOptions }) => {
      const rateLimitMiddleware = authorizationRateLimitMiddleware({
        redis: redisOptions,
        keyPrefix: "test-fixed",
        defaultLimiter: {
          type: "fixedWindow",
          window: "10s",
          tokens: 3,
        },
        pathMatchers: [/^\/api/],
      });

      app.use(rateLimitMiddleware);
      app.get("/api/test", (req, res) => res.status(200).json({ message: "Success" }));

      const makeRequest = () =>
        request(app).get("/api/test").set("Authorization", "Bearer test-token");

      // Should allow 3 requests
      for (let i = 0; i < 3; i++) {
        const response = await makeRequest();
        expect(response.status).toBe(200);
      }

      // 4th request should be rate limited
      const limitedResponse = await makeRequest();
      expect(limitedResponse.status).toBe(429);

      // Wait for the window to reset
      await new Promise((resolve) => setTimeout(resolve, 10000));

      // Should allow requests again
      const newResponse = await makeRequest();
      expect(newResponse.status).toBe(200);
    });

    redisTest("should enforce sliding window rate limiting", async ({ redisOptions }) => {
      const rateLimitMiddleware = authorizationRateLimitMiddleware({
        redis: redisOptions,
        keyPrefix: "test-sliding",
        defaultLimiter: {
          type: "slidingWindow",
          window: "10s",
          tokens: 3,
        },
        pathMatchers: [/^\/api/],
      });

      app.use(rateLimitMiddleware);
      app.get("/api/test", (req, res) => res.status(200).json({ message: "Success" }));

      const makeRequest = () =>
        request(app).get("/api/test").set("Authorization", "Bearer test-token");

      // Should allow 3 requests
      for (let i = 0; i < 3; i++) {
        const response = await makeRequest();
        expect(response.status).toBe(200);
      }

      // 4th request should be rate limited
      const limitedResponse = await makeRequest();
      expect(limitedResponse.status).toBe(429);

      // Wait for part of the window to pass
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Should still be limited
      const stillLimitedResponse = await makeRequest();
      expect(stillLimitedResponse.status).toBe(429);

      // Wait for the full window to pass
      await new Promise((resolve) => setTimeout(resolve, 10000));

      // Should allow requests again
      const newResponse = await makeRequest();
      expect(newResponse.status).toBe(200);
    });

    // 2. Test edge cases around rate limit calculations
    redisTest("should handle token refill correctly", async ({ redisOptions }) => {
      const rateLimitMiddleware = authorizationRateLimitMiddleware({
        redis: redisOptions,
        keyPrefix: "test-refill",
        defaultLimiter: {
          type: "tokenBucket",
          refillRate: 1,
          interval: "5s",
          maxTokens: 3,
        },
        pathMatchers: [/^\/api/],
      });

      app.use(rateLimitMiddleware);
      app.get("/api/test", (req, res) => res.status(200).json({ message: "Success" }));

      const makeRequest = () =>
        request(app).get("/api/test").set("Authorization", "Bearer test-token");

      // Use up all tokens
      for (let i = 0; i < 3; i++) {
        const response = await makeRequest();
        expect(response.status).toBe(200);
      }

      // Next request should be limited
      const limitedResponse = await makeRequest();
      expect(limitedResponse.status).toBe(429);

      // Wait for one token to be refilled
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Should allow one request
      const newResponse = await makeRequest();
      expect(newResponse.status).toBe(200);

      // But the next one should be limited again
      const limitedAgainResponse = await makeRequest();
      expect(limitedAgainResponse.status).toBe(429);
    });

    redisTest("should handle near-zero remaining tokens correctly", async ({ redisOptions }) => {
      const rateLimitMiddleware = authorizationRateLimitMiddleware({
        redis: redisOptions,
        keyPrefix: "test-near-zero",
        defaultLimiter: {
          type: "tokenBucket",
          refillRate: 1, // 1 token every 5 seconds
          interval: "5s",
          maxTokens: 1,
        },
        pathMatchers: [/^\/api/],
      });

      app.use(rateLimitMiddleware);
      app.get("/api/test", (req, res) => res.status(200).json({ message: "Success" }));

      const makeRequest = () =>
        request(app).get("/api/test").set("Authorization", "Bearer test-token");

      // First request should succeed
      const firstResponse = await makeRequest();
      expect(firstResponse.status).toBe(200);

      // Immediate second request should fail
      const secondResponse = await makeRequest();
      expect(secondResponse.status).toBe(429);

      // Wait for almost one token to be refilled (4.9 seconds)
      await new Promise((resolve) => setTimeout(resolve, 4900));

      // This request should still fail as we're just shy of a full token
      const thirdResponse = await makeRequest();
      expect(thirdResponse.status).toBe(429);

      // Wait for the full token to be refilled (additional 200ms)
      await new Promise((resolve) => setTimeout(resolve, 200));

      // This request should now succeed
      const fourthResponse = await makeRequest();
      expect(fourthResponse.status).toBe(200);

      // Immediate next request should fail again
      const fifthResponse = await makeRequest();
      expect(fifthResponse.status).toBe(429);
    });

    // 3. Test the limiterCache functionality
    redisTest("should use cached limiter configurations", async ({ redisOptions }) => {
      let configOverrideCalls = 0;
      const rateLimitMiddleware = authorizationRateLimitMiddleware({
        redis: redisOptions,
        keyPrefix: "test-cache",
        defaultLimiter: {
          type: "tokenBucket",
          refillRate: 1,
          interval: "1m",
          maxTokens: 10,
        },
        pathMatchers: [/^\/api/],
        limiterCache: {
          fresh: 1000, // 1 second
          stale: 2000, // 2 seconds
          maxItems: 1000,
        },
        limiterConfigOverride: async (authorizationValue) => {
          configOverrideCalls++;
          if (authorizationValue === "Bearer premium-token") {
            return {
              type: "tokenBucket",
              refillRate: 10,
              interval: "1m",
              maxTokens: 100,
            };
          }
          return undefined;
        },
      });

      app.use(rateLimitMiddleware);
      app.get("/api/test", (req, res) => res.status(200).json({ message: "Success" }));

      const makeRequest = () =>
        request(app).get("/api/test").set("Authorization", "Bearer premium-token");

      // First request should call the override
      await makeRequest();
      expect(configOverrideCalls).toBe(1);

      // Subsequent requests within 1 second should use the cache
      await makeRequest();
      await makeRequest();
      expect(configOverrideCalls).toBe(1);

      // Wait for the cache to become stale
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // This should still use the cache, but also trigger a refresh
      await makeRequest();
      expect(configOverrideCalls).toBe(2);

      // Wait for the cache to expire completely
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // This should trigger a new override call
      await makeRequest();
      expect(configOverrideCalls).toBe(3);
    });
  });
});
