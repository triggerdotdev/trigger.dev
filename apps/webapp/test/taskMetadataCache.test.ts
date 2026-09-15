import { redisTest } from "@internal/testcontainers";
import Redis from "ioredis";
import { describe, expect, vi } from "vitest";
import { RedisTaskMetadataCache } from "../app/services/taskMetadataCache.server.js";

vi.setConfig({ testTimeout: 30_000 });

describe("RedisTaskMetadataCache regions", () => {
  redisTest("round-trips regions through both keyspaces", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    try {
      const cache = new RedisTaskMetadataCache({ redis });

      await cache.populateByCurrentWorker("env_1", "worker_1", [
        {
          slug: "eu-task",
          ttl: null,
          triggerSource: "STANDARD",
          queueId: null,
          queueName: "task/eu-task",
          regions: ["eu-central-1", "us-east-1"],
        },
        {
          slug: "any-task",
          ttl: "1h",
          triggerSource: "AGENT",
          queueId: "q_1",
          queueName: "task/any-task",
          regions: [],
        },
      ]);

      expect(await cache.getCurrent("env_1", "eu-task")).toEqual({
        slug: "eu-task",
        ttl: null,
        triggerSource: "STANDARD",
        queueId: null,
        queueName: "task/eu-task",
        regions: ["eu-central-1", "us-east-1"],
      });

      expect(await cache.getByWorker("worker_1", "any-task")).toEqual({
        slug: "any-task",
        ttl: "1h",
        triggerSource: "AGENT",
        queueId: "q_1",
        queueName: "task/any-task",
        regions: [],
      });
    } finally {
      await redis.quit();
    }
  });

  redisTest(
    "omits the regions field on the wire when the list is empty",
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      try {
        const cache = new RedisTaskMetadataCache({ redis });

        await cache.setByWorker("worker_1", {
          slug: "any-task",
          ttl: null,
          triggerSource: "STANDARD",
          queueId: null,
          queueName: "task/any-task",
          regions: [],
        });

        const raw = await redis.hget("task-meta:by-worker:worker_1", "any-task");
        expect(raw).not.toBeNull();
        // No-region entries must stay byte-identical to entries written before
        // regions existed, so the encoded payload carries no `r` key at all.
        expect(JSON.parse(raw!)).toEqual({ t: null, k: "STANDARD", q: null, n: "task/any-task" });
      } finally {
        await redis.quit();
      }
    }
  );

  redisTest(
    "decodes entries written before regions existed as unconstrained",
    async ({ redisOptions }) => {
      const redis = new Redis(redisOptions);
      try {
        const cache = new RedisTaskMetadataCache({ redis });

        await redis.hset(
          "task-meta:env:env_1",
          "legacy-task",
          JSON.stringify({ t: null, k: "STANDARD", q: null, n: "task/legacy-task" })
        );

        expect(await cache.getCurrent("env_1", "legacy-task")).toEqual({
          slug: "legacy-task",
          ttl: null,
          triggerSource: "STANDARD",
          queueId: null,
          queueName: "task/legacy-task",
          regions: [],
        });
      } finally {
        await redis.quit();
      }
    }
  );
});
