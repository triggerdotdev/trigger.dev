import { describe, expect, test } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import {
  InMemoryEventRateLimitChecker,
  RedisEventRateLimitChecker,
  windowToMs,
  parseEventRateLimitConfig,
} from "../../app/v3/services/events/eventRateLimiter.server";

describe("windowToMs", () => {
  test("converts seconds", () => {
    expect(windowToMs("10s")).toBe(10_000);
    expect(windowToMs("1s")).toBe(1_000);
  });

  test("converts minutes", () => {
    expect(windowToMs("1m")).toBe(60_000);
    expect(windowToMs("5m")).toBe(300_000);
  });

  test("converts hours", () => {
    expect(windowToMs("1h")).toBe(3_600_000);
    expect(windowToMs("2h")).toBe(7_200_000);
  });

  test("throws on invalid format", () => {
    expect(() => windowToMs("abc")).toThrow("Invalid window format");
    expect(() => windowToMs("10d")).toThrow("Invalid window format");
    expect(() => windowToMs("")).toThrow("Invalid window format");
  });
});

describe("parseEventRateLimitConfig", () => {
  test("parses valid config", () => {
    const result = parseEventRateLimitConfig({ limit: 100, window: "1m" });
    expect(result).toEqual({ limit: 100, window: "1m" });
  });

  test("returns undefined for null/undefined", () => {
    expect(parseEventRateLimitConfig(null)).toBeUndefined();
    expect(parseEventRateLimitConfig(undefined)).toBeUndefined();
  });

  test("returns undefined for invalid config", () => {
    expect(parseEventRateLimitConfig({ limit: -1, window: "1m" })).toBeUndefined();
    expect(parseEventRateLimitConfig({ limit: 100 })).toBeUndefined();
    expect(parseEventRateLimitConfig("not an object")).toBeUndefined();
  });
});

describe("InMemoryEventRateLimitChecker", () => {
  test("allows requests within limit", async () => {
    const checker = new InMemoryEventRateLimitChecker();
    const config = { limit: 3, window: "10s" };

    const r1 = await checker.check("key1", config);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await checker.check("key1", config);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await checker.check("key1", config);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  test("blocks requests exceeding limit", async () => {
    const checker = new InMemoryEventRateLimitChecker();
    const config = { limit: 2, window: "10s" };

    await checker.check("key1", config);
    await checker.check("key1", config);

    const r3 = await checker.check("key1", config);
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
    expect(r3.retryAfter).toBeDefined();
    expect(r3.retryAfter!).toBeGreaterThan(0);
  });

  test("different keys are independent", async () => {
    const checker = new InMemoryEventRateLimitChecker();
    const config = { limit: 1, window: "10s" };

    const r1 = await checker.check("key-a", config);
    expect(r1.allowed).toBe(true);

    const r2 = await checker.check("key-b", config);
    expect(r2.allowed).toBe(true);

    // key-a is now exhausted
    const r3 = await checker.check("key-a", config);
    expect(r3.allowed).toBe(false);

    // key-b is also exhausted
    const r4 = await checker.check("key-b", config);
    expect(r4.allowed).toBe(false);
  });

  test("reset clears all state", async () => {
    const checker = new InMemoryEventRateLimitChecker();
    const config = { limit: 1, window: "10s" };

    await checker.check("key1", config);

    const blocked = await checker.check("key1", config);
    expect(blocked.allowed).toBe(false);

    checker.reset();

    const afterReset = await checker.check("key1", config);
    expect(afterReset.allowed).toBe(true);
  });
});

// ─── RedisEventRateLimitChecker (needs Redis container) ───

function createUpstashAdapter(redis: ReturnType<typeof createRedisClient>) {
  return {
    sadd: async <TData>(key: string, ...members: TData[]): Promise<number> => {
      return redis.sadd(key, members as (string | number | Buffer)[]);
    },
    hset: <TValue>(
      key: string,
      obj: {
        [key: string]: TValue;
      }
    ): Promise<number> => {
      return redis.hset(key, obj);
    },
    eval: <TArgs extends unknown[], TData = unknown>(
      ...args: [script: string, keys: string[], args: TArgs]
    ): Promise<TData> => {
      const script = args[0];
      const keys = args[1];
      const argsArray = args[2];
      return redis.eval(
        script,
        keys.length,
        ...keys,
        ...(argsArray as (string | Buffer | number)[])
      ) as Promise<TData>;
    },
  };
}

redisTest(
  "RedisEventRateLimitChecker allows requests within limit",
  { timeout: 30_000 },
  async ({ redisOptions }) => {
    const redis = createRedisClient("test:rateLimiter", redisOptions);

    try {
      const checker = new RedisEventRateLimitChecker(createUpstashAdapter(redis));
      const config = { limit: 3, window: "10s" };

      const r1 = await checker.check("redis-key-1", config);
      expect(r1.allowed).toBe(true);

      const r2 = await checker.check("redis-key-1", config);
      expect(r2.allowed).toBe(true);

      const r3 = await checker.check("redis-key-1", config);
      expect(r3.allowed).toBe(true);
    } finally {
      redis.disconnect();
    }
  }
);

redisTest(
  "RedisEventRateLimitChecker blocks requests exceeding limit",
  { timeout: 30_000 },
  async ({ redisOptions }) => {
    const redis = createRedisClient("test:rateLimiter", redisOptions);

    try {
      const checker = new RedisEventRateLimitChecker(createUpstashAdapter(redis));
      const config = { limit: 2, window: "10s" };

      await checker.check("redis-key-2", config);
      await checker.check("redis-key-2", config);

      const result = await checker.check("redis-key-2", config);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    } finally {
      redis.disconnect();
    }
  }
);

redisTest(
  "RedisEventRateLimitChecker isolates keys",
  { timeout: 30_000 },
  async ({ redisOptions }) => {
    const redis = createRedisClient("test:rateLimiter", redisOptions);

    try {
      const checker = new RedisEventRateLimitChecker(createUpstashAdapter(redis));
      const config = { limit: 1, window: "10s" };

      const r1 = await checker.check("redis-key-a", config);
      expect(r1.allowed).toBe(true);

      const r2 = await checker.check("redis-key-b", config);
      expect(r2.allowed).toBe(true);

      const r3 = await checker.check("redis-key-a", config);
      expect(r3.allowed).toBe(false);
    } finally {
      redis.disconnect();
    }
  }
);
