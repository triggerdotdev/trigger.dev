import { redisTest } from "@internal/testcontainers";
import express from "express";
import { Redis } from "ioredis";
import type { AddressInfo } from "node:net";
import { describe, expect, test, vi } from "vitest";
import { createMcpPreAuthRateLimit } from "~/mcp/preAuthRateLimit.server";
import { createMcpRouter } from "~/mcp/server.server";
import type { McpIdentity } from "~/mcp/types";

vi.setConfig({ testTimeout: 60_000 });

vi.hoisted(() => {
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
    DIRECT_URL: "postgresql://unused:unused@localhost:5432/unused",
    MAGIC_LINK_SECRET: "magic-link-secret-for-tests",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    DEPLOY_REGISTRY_HOST: "registry.test",
    V4_DEPLOY_REGISTRY_HOST: "registry.test",
    CLICKHOUSE_URL: "http://localhost:8123",
  });
});

async function withServer(
  preAuth: ReturnType<typeof createMcpPreAuthRateLimit>,
  fn: (
    post: (headers: Record<string, string>) => Promise<Response>,
    calls: () => number
  ) => Promise<void>
) {
  let authCalls = 0;
  const app = express();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  app.use(
    "/mcp",
    createMcpRouter({
      allowedOrigin: origin,
      authenticate: async (request) => {
        authCalls++;
        if (request.headers.get("authorization") === "Bearer valid") {
          return { ok: true, identity: {} as McpIdentity };
        }
        return { ok: false, response: new Response("unauthorized", { status: 401 }) };
      },
      rateLimit: (_req, _res, next) => next(),
      tools: [],
      preAuth,
    })
  );
  const url = `${origin}/mcp`;
  try {
    await fn(
      (headers) =>
        fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            ...headers,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        }),
      () => authCalls
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("MCP pre-auth IP rate limit", () => {
  // Catches: limit raised, successes counted, first XFF hop keyed, or gate placed after auth.
  redisTest("counts failed auth per client IP before auth runs", async ({ redisOptions }) => {
    const preAuth = createMcpPreAuthRateLimit({ redis: { ...redisOptions, tlsDisabled: true } });
    await withServer(preAuth, async (post, calls) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-01-01T00:00:01Z"));
      try {
        for (let i = 0; i < 130; i++) {
          const res = await post({ authorization: "Bearer valid", "x-forwarded-for": "1.1.1.1" });
          expect(res.status).toBe(200);
        }

        for (let i = 0; i < 120; i++) {
          const res = await post({
            authorization: "Bearer tr_pat_forged",
            "x-forwarded-for": `9.9.9.${i}, 1.1.1.1`,
          });
          expect(res.status).toBe(401);
        }
        const before = calls();
        const limited = await post({
          authorization: "Bearer tr_pat_forged",
          "x-forwarded-for": "8.8.8.8, 1.1.1.1",
        });
        expect(limited.status).toBe(429);
        expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
        expect(calls()).toBe(before);

        const other = await post({ authorization: "Bearer x", "x-forwarded-for": "2.2.2.2" });
        expect(other.status).toBe(401);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // Catches: an untagged identifier, whose two window keys hit different cluster slots.
  redisTest("tags the client IP so both window keys share a slot", async ({ redisOptions }) => {
    const preAuth = createMcpPreAuthRateLimit({ redis: { ...redisOptions, tlsDisabled: true } });
    await withServer(preAuth, async (post) => {
      await post({ authorization: "Bearer forged", "x-forwarded-for": "4.4.4.4" });
    });
    const redis = new Redis(redisOptions);
    try {
      const keys = await redis.keys("ratelimit:auth:mcp:preauth:ip:*");
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) expect(key).toContain(":{4.4.4.4}:");
    } finally {
      redis.disconnect();
    }
  });

  // Catches: a limiter error rejecting the request instead of failing open.
  test("fails open when Redis is unreachable", async () => {
    const preAuth = createMcpPreAuthRateLimit({
      redis: { host: "127.0.0.1", port: 1, tlsDisabled: true, retryStrategy: () => null },
    });
    await withServer(preAuth, async (post) => {
      const res = await post({ authorization: "Bearer forged", "x-forwarded-for": "3.3.3.3" });
      expect(res.status).toBe(401);
    });
  });
});
