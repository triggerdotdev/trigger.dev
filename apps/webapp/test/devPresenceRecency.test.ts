import { redisTest } from "@internal/testcontainers";
import { subDays } from "date-fns";
import Redis from "ioredis";
import { describe, expect, vi } from "vitest";
import { DevPresence } from "~/presenters/v3/DevPresence.server";

vi.setConfig({ testTimeout: 30_000 });

let seq = 0;
function ids() {
  seq += 1;
  return { userId: `user_${seq}`, projectId: `proj_${seq}` };
}
const recentKey = (userId: string, projectId: string) => `dev-recent:${userId}:${projectId}`;

describe("DevPresence — recency ZSET", () => {
  redisTest("getRecentBranchIds returns an empty map when nothing has pinged", async ({ redisOptions }) => {
    const presence = new DevPresence(redisOptions);
    const { userId, projectId } = ids();

    const result = await presence.getRecentBranchIds(userId, projectId);
    expect(result.size).toBe(0);
  });

  redisTest("a ping records the branch as recently active", async ({ redisOptions }) => {
    const presence = new DevPresence(redisOptions);
    const { userId, projectId } = ids();

    await presence.setConnected({ userId, projectId, environmentId: "env_a", ttl: 60 });

    const result = await presence.getRecentBranchIds(userId, projectId);
    expect([...result.keys()]).toEqual(["env_a"]);
    expect(result.get("env_a")).toBeInstanceOf(Date);
  });

  redisTest("debounces to at most one ZADD per env per minute", async ({ redisOptions }) => {
    const presence = new DevPresence(redisOptions);
    const redis = new Redis(redisOptions);
    const { userId, projectId } = ids();

    // First ping records env_a.
    await presence.setConnected({ userId, projectId, environmentId: "env_a", ttl: 60 });

    // Simulate the entry being removed (e.g. another reader pruned it) while the
    // 60s debounce touch key is still live.
    await redis.zrem(recentKey(userId, projectId), "env_a");

    // A second ping within the debounce window must NOT re-add it.
    await presence.setConnected({ userId, projectId, environmentId: "env_a", ttl: 60 });

    const result = await presence.getRecentBranchIds(userId, projectId);
    expect(result.has("env_a")).toBe(false);

    await redis.quit();
  });

  redisTest("does not return entries older than the recency window", async ({ redisOptions }) => {
    const presence = new DevPresence(redisOptions);
    const redis = new Redis(redisOptions);
    const { userId, projectId } = ids();
    const key = recentKey(userId, projectId);

    const fourDaysAgo = subDays(Date.now(), 4).getTime();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    await redis.zadd(key, fourDaysAgo, "env_stale", oneHourAgo, "env_fresh");

    const result = await presence.getRecentBranchIds(userId, projectId);
    expect([...result.keys()]).toEqual(["env_fresh"]);

    await redis.quit();
  });

  redisTest("physically prunes stale entries on the next ping", async ({ redisOptions }) => {
    const presence = new DevPresence(redisOptions);
    const redis = new Redis(redisOptions);
    const { userId, projectId } = ids();
    const key = recentKey(userId, projectId);

    await redis.zadd(key, subDays(Date.now(), 4).getTime(), "env_stale");

    // A fresh ping triggers the ZREMRANGEBYSCORE cleanup for this user/project.
    await presence.setConnected({ userId, projectId, environmentId: "env_fresh", ttl: 60 });

    expect(await redis.zscore(key, "env_stale")).toBeNull();
    expect(await redis.zcard(key)).toBe(1);

    await redis.quit();
  });

  redisTest("caps cardinality at 50 even under a flood of distinct branches", async ({ redisOptions }) => {
    const presence = new DevPresence(redisOptions);
    const redis = new Redis(redisOptions);
    const { userId, projectId } = ids();

    // 60 distinct envs, each with its own debounce key, so each performs a ZADD.
    for (let i = 0; i < 60; i++) {
      // eslint-disable-next-line no-await-in-loop
      await presence.setConnected({ userId, projectId, environmentId: `env_${i}`, ttl: 60 });
    }

    expect(await redis.zcard(recentKey(userId, projectId))).toBe(50);

    await redis.quit();
  });

  redisTest("returns recent branches in most-recent-first order", async ({ redisOptions }) => {
    const presence = new DevPresence(redisOptions);
    const redis = new Redis(redisOptions);
    const { userId, projectId } = ids();
    const key = recentKey(userId, projectId);

    const now = Date.now();
    await redis.zadd(
      key,
      now - 3000,
      "env_oldest",
      now - 2000,
      "env_middle",
      now - 1000,
      "env_newest"
    );

    const result = await presence.getRecentBranchIds(userId, projectId);
    expect([...result.keys()]).toEqual(["env_newest", "env_middle", "env_oldest"]);

    await redis.quit();
  });
});
