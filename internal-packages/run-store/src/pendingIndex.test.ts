// Pending-index scaffolding (M2): per-partition recovery streams with a consumer group each, plus
// add/enumerate primitives. No recovery worker and no prepare protocol here (M3/M4). Real Redis.
import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { PendingIndex, RECOVERY_CONSUMER_GROUP } from "./pendingIndex.js";
import { pendingStreamKey, runToPartition } from "./snapshotKeys.js";

describe("PendingIndex", () => {
  redisTest(
    "creates a partition stream and consumer group idempotently",
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(redis);
      try {
        await index.ensureGroup(7);
        // A second call must not throw on BUSYGROUP.
        await index.ensureGroup(7);

        const groups = (await redis.xinfo("GROUPS", pendingStreamKey(7))) as unknown[];
        const names = groups.map((g) => (g as string[])[1]);
        expect(names).toContain(RECOVERY_CONSUMER_GROUP);
      } finally {
        await redis.quit();
      }
    }
  );

  redisTest(
    "adds an entry to the run's partition stream and enumerates it",
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(redis);
      try {
        const runId = "run_pending_1";
        const partition = runToPartition(runId);
        await index.ensureGroup(partition);

        const id = await index.add(runId, { runId, transitionToken: "t1" });
        expect(id).toMatch(/^\d+-\d+$/);

        const entries = await index.enumerate(partition);
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe(id);
        expect(entries[0].fields.runId).toBe(runId);
        expect(entries[0].fields.transitionToken).toBe("t1");
      } finally {
        await redis.quit();
      }
    }
  );

  redisTest(
    "enumerates entries across a partition in insertion order",
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(redis);
      try {
        const runId = "run_pending_2";
        const partition = runToPartition(runId);
        await index.ensureGroup(partition);

        const id1 = await index.add(runId, { runId, seq: "1" });
        const id2 = await index.add(runId, { runId, seq: "2" });

        const entries = await index.enumerate(partition);
        expect(entries.map((e) => e.id)).toEqual([id1, id2]);
        expect(entries.map((e) => e.fields.seq)).toEqual(["1", "2"]);
      } finally {
        await redis.quit();
      }
    }
  );

  redisTest(
    "ensureAllGroups creates every one of the 256 partition streams",
    async ({ redisOptions }) => {
      const redis = createRedisClient(redisOptions, { onError: () => {} });
      const index = new PendingIndex(redis);
      try {
        await index.ensureAllGroups();
        for (const partition of [0, 1, 128, 255]) {
          const groups = (await redis.xinfo("GROUPS", pendingStreamKey(partition))) as unknown[];
          expect(groups.map((g) => (g as string[])[1])).toContain(RECOVERY_CONSUMER_GROUP);
        }
      } finally {
        await redis.quit();
      }
    }
  );
});
