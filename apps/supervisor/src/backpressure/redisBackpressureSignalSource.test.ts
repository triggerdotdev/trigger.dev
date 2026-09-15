import { redisTest } from "@internal/testcontainers";
import { Redis } from "ioredis";
import { describe, expect } from "vitest";
import { RedisBackpressureSignalSource } from "./redisBackpressureSignalSource.js";

const KEY = "backpressure:test";

describe("RedisBackpressureSignalSource", () => {
  redisTest("returns null when the key is absent", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    try {
      const source = new RedisBackpressureSignalSource(redis, KEY);
      expect(await source.read()).toBeNull();
    } finally {
      await redis.quit();
    }
  });

  redisTest("parses a valid engaged verdict", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    try {
      await redis.set(KEY, JSON.stringify({ engaged: true, ts: 1_700_000_000_000 }));
      const source = new RedisBackpressureSignalSource(redis, KEY);
      expect(await source.read()).toEqual({ engaged: true, ts: 1_700_000_000_000 });
    } finally {
      await redis.quit();
    }
  });

  redisTest("parses a clear verdict", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    try {
      await redis.set(KEY, JSON.stringify({ engaged: false }));
      const source = new RedisBackpressureSignalSource(redis, KEY);
      expect(await source.read()).toEqual({ engaged: false });
    } finally {
      await redis.quit();
    }
  });

  redisTest("returns null for malformed JSON (fail-open)", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    try {
      await redis.set(KEY, "not json {");
      const source = new RedisBackpressureSignalSource(redis, KEY);
      expect(await source.read()).toBeNull();
    } finally {
      await redis.quit();
    }
  });

  redisTest(
    "returns null for valid JSON of the wrong shape (fail-open)",
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      try {
        await redis.set(KEY, JSON.stringify({ foo: "bar" }));
        const source = new RedisBackpressureSignalSource(redis, KEY);
        expect(await source.read()).toBeNull();
      } finally {
        await redis.quit();
      }
    }
  );
});
