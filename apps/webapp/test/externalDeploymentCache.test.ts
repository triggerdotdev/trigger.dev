import { redisTest } from "@internal/testcontainers";
import { Redis } from "ioredis";
import { describe, expect } from "vitest";
import { RedisExternalDeploymentCache } from "~/services/externalDeploymentCache.server";

vi.setConfig({ testTimeout: 30_000 });

function entry(version: string, workerId = `worker_${version}`) {
  return { workerId, version, sdkVersion: "4.0.0", cliVersion: "4.0.0" };
}

function deployed(version: string, workerId = `worker_${version}`) {
  return { outcome: "deployed", entry: entry(version, workerId) };
}

describe("RedisExternalDeploymentCache", () => {
  redisTest("stores and reads back a resolution", async ({ redisOptions }) => {
    const redis = new Redis({ ...redisOptions, maxRetriesPerRequest: null });
    const cache = new RedisExternalDeploymentCache({ redis });

    try {
      expect(await cache.get("env_1", "commit-a")).toBeNull();

      await cache.setIfNewer("env_1", "commit-a", entry("20260807.1"));

      expect(await cache.get("env_1", "commit-a")).toEqual(deployed("20260807.1"));
    } finally {
      await redis.quit();
    }
  });

  redisTest("scopes entries by environment", async ({ redisOptions }) => {
    const redis = new Redis({ ...redisOptions, maxRetriesPerRequest: null });
    const cache = new RedisExternalDeploymentCache({ redis });

    try {
      await cache.setIfNewer("env_1", "commit-a", entry("20260807.1"));

      expect(await cache.get("env_2", "commit-a")).toBeNull();
    } finally {
      await redis.quit();
    }
  });

  redisTest("overwrites when the finalising version is higher", async ({ redisOptions }) => {
    const redis = new Redis({ ...redisOptions, maxRetriesPerRequest: null });
    const cache = new RedisExternalDeploymentCache({ redis });

    try {
      await cache.setIfNewer("env_1", "commit-a", entry("20260807.1"));
      await cache.setIfNewer("env_1", "commit-a", entry("20260807.2"));

      expect(await cache.get("env_1", "commit-a")).toEqual(deployed("20260807.2"));
    } finally {
      await redis.quit();
    }
  });

  redisTest(
    "refuses a lower version — the slower earlier build finalising last must not reinstate the version the operator was replacing",
    async ({ redisOptions }) => {
      const redis = new Redis({ ...redisOptions, maxRetriesPerRequest: null });
      const cache = new RedisExternalDeploymentCache({ redis });

      try {
        await cache.setIfNewer("env_1", "commit-a", entry("20260807.2"));
        await cache.setIfNewer("env_1", "commit-a", entry("20260807.1"));

        expect(await cache.get("env_1", "commit-a")).toEqual(deployed("20260807.2"));
      } finally {
        await redis.quit();
      }
    }
  );

  redisTest("refuses an equal version", async ({ redisOptions }) => {
    const redis = new Redis({ ...redisOptions, maxRetriesPerRequest: null });
    const cache = new RedisExternalDeploymentCache({ redis });

    try {
      await cache.setIfNewer("env_1", "commit-a", entry("20260807.1", "worker_first"));
      await cache.setIfNewer("env_1", "commit-a", entry("20260807.1", "worker_second"));

      expect(await cache.get("env_1", "commit-a")).toEqual(deployed("20260807.1", "worker_first"));
    } finally {
      await redis.quit();
    }
  });

  redisTest(
    "compares the counter numerically, not lexicographically — .10 beats .9",
    async ({ redisOptions }) => {
      const redis = new Redis({ ...redisOptions, maxRetriesPerRequest: null });
      const cache = new RedisExternalDeploymentCache({ redis });

      try {
        await cache.setIfNewer("env_1", "commit-a", entry("20260807.9"));
        await cache.setIfNewer("env_1", "commit-a", entry("20260807.10"));

        expect(await cache.get("env_1", "commit-a")).toEqual(deployed("20260807.10"));

        await cache.setIfNewer("env_1", "commit-a", entry("20260807.9"));
        expect(await cache.get("env_1", "commit-a")).toEqual(deployed("20260807.10"));
      } finally {
        await redis.quit();
      }
    }
  );

  redisTest("a later date wins regardless of counter", async ({ redisOptions }) => {
    const redis = new Redis({ ...redisOptions, maxRetriesPerRequest: null });
    const cache = new RedisExternalDeploymentCache({ redis });

    try {
      await cache.setIfNewer("env_1", "commit-a", entry("20260807.50"));
      await cache.setIfNewer("env_1", "commit-a", entry("20260808.1"));

      expect(await cache.get("env_1", "commit-a")).toEqual(deployed("20260808.1"));

      await cache.setIfNewer("env_1", "commit-a", entry("20260806.99"));
      expect(await cache.get("env_1", "commit-a")).toEqual(deployed("20260808.1"));
    } finally {
      await redis.quit();
    }
  });

  redisTest("caches a missing resolution with a short TTL", async ({ redisOptions }) => {
    const redis = new Redis({ ...redisOptions, maxRetriesPerRequest: null });
    const cache = new RedisExternalDeploymentCache({ redis, missingTtlSeconds: 30 });

    try {
      await cache.setMissing("env_1", "commit-a");

      expect(await cache.get("env_1", "commit-a")).toEqual({ outcome: "missing" });

      const ttl = await redis.ttl("skewid:env_1:commit-a");

      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(30);
    } finally {
      await redis.quit();
    }
  });

  redisTest("a landed deployment replaces a missing marker", async ({ redisOptions }) => {
    const redis = new Redis({ ...redisOptions, maxRetriesPerRequest: null });
    const cache = new RedisExternalDeploymentCache({ redis });

    try {
      await cache.setMissing("env_1", "commit-a");
      await cache.setIfNewer("env_1", "commit-a", entry("20260807.1"));

      expect(await cache.get("env_1", "commit-a")).toEqual(deployed("20260807.1"));
    } finally {
      await redis.quit();
    }
  });

  redisTest("a missing marker never clobbers a resolution", async ({ redisOptions }) => {
    const redis = new Redis({ ...redisOptions, maxRetriesPerRequest: null });
    const cache = new RedisExternalDeploymentCache({ redis });

    try {
      await cache.setIfNewer("env_1", "commit-a", entry("20260807.1"));
      await cache.setMissing("env_1", "commit-a");

      expect(await cache.get("env_1", "commit-a")).toEqual(deployed("20260807.1"));
    } finally {
      await redis.quit();
    }
  });

  redisTest("sets a TTL on the entry", async ({ redisOptions }) => {
    const redis = new Redis({ ...redisOptions, maxRetriesPerRequest: null });
    const cache = new RedisExternalDeploymentCache({ redis, ttlSeconds: 120 });

    try {
      await cache.setIfNewer("env_1", "commit-a", entry("20260807.1"));

      const ttl = await redis.ttl("skewid:env_1:commit-a");

      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120);
    } finally {
      await redis.quit();
    }
  });
});
