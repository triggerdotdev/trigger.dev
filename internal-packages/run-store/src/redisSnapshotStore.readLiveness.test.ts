// The write guard and the read path must agree on what a live keyspace is. The append script
// refuses a transition unless BOTH `e` and `seq` exist; a read that keys off `cur` or `e` alone
// keeps serving the frozen head after `seq` is evicted, and a stale hit is not a miss, so the
// decorator's Postgres fallback never fires and the two stores diverge permanently.
import { createRedisClient, type RedisOptions } from "@internal/redis";
import { redisTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import {
  RedisSnapshotStore,
  snapshotKeys,
  type SnapshotEntryInput,
} from "./redisSnapshotStore.js";

function entry(over: Partial<SnapshotEntryInput> = {}): SnapshotEntryInput {
  return {
    id: "snap_1",
    engine: "V2",
    executionStatus: "RUN_CREATED",
    description: "created",
    runId: "run_1",
    runStatus: "PENDING",
    createdAt: "2026-08-21T00:00:00.000Z",
    environmentId: "env_1",
    environmentType: "PRODUCTION",
    projectId: "proj_1",
    organizationId: "org_1",
    ...over,
  };
}

async function seededStore(redisOptions: RedisOptions) {
  const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
  await store.append({ entry: entry({ id: "snap_1" }), kind: "birth", isTerminal: false });
  await store.append({
    entry: entry({ id: "snap_2", createdAt: "2026-08-21T00:00:01.000Z" }),
    kind: "transition",
    isTerminal: false,
    cycle: { kind: "new", completedWaitpoints: [{ id: "w_a", index: 0 }] },
  });
  return store;
}

async function evict(redisOptions: RedisOptions, key: string) {
  const raw = createRedisClient(redisOptions);
  try {
    await raw.del(key);
  } finally {
    await raw.quit();
  }
}

describe("read liveness anchors", () => {
  redisTest("getLatest misses once the seq anchor is gone", async ({ redisOptions }) => {
    const store = await seededStore(redisOptions);
    try {
      expect(await store.getLatest("run_1")).not.toBeNull();
      await evict(redisOptions, snapshotKeys("run_1").seq);
      expect(await store.getLatest("run_1")).toBeNull();
    } finally {
      await store.quit();
    }
  });

  redisTest("getById misses once the seq anchor is gone", async ({ redisOptions }) => {
    const store = await seededStore(redisOptions);
    try {
      expect(await store.getById("run_1", "snap_2")).not.toBeNull();
      await evict(redisOptions, snapshotKeys("run_1").seq);
      expect(await store.getById("run_1", "snap_2")).toBeNull();
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "getSnapshotWaitpointIds reports not present once the seq anchor is gone",
    async ({ redisOptions }) => {
      const store = await seededStore(redisOptions);
      try {
        expect(await store.getSnapshotWaitpointIds("run_1", "snap_2")).toMatchObject({
          present: true,
        });
        await evict(redisOptions, snapshotKeys("run_1").seq);
        expect(await store.getSnapshotWaitpointIds("run_1", "snap_2")).toEqual({
          present: false,
          distinctIds: [],
          order: [],
        });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("getSinceCreatedAt misses once the seq anchor is gone", async ({ redisOptions }) => {
    const store = await seededStore(redisOptions);
    try {
      expect(await store.getSinceCreatedAt("run_1", "2026-08-21T00:00:00.000Z")).toMatchObject({
        kind: "hit",
      });
      await evict(redisOptions, snapshotKeys("run_1").seq);
      expect(await store.getSinceCreatedAt("run_1", "2026-08-21T00:00:00.000Z")).toEqual({
        kind: "miss",
      });
    } finally {
      await store.quit();
    }
  });

  redisTest("getSince misses once the seq anchor is gone", async ({ redisOptions }) => {
    const store = await seededStore(redisOptions);
    try {
      expect(await store.getSince("run_1", "snap_1")).toMatchObject({ kind: "hit" });
      await evict(redisOptions, snapshotKeys("run_1").seq);
      expect(await store.getSince("run_1", "snap_1")).toEqual({ kind: "miss" });
    } finally {
      await store.quit();
    }
  });

  redisTest("getSince misses once the index anchor is gone", async ({ redisOptions }) => {
    const store = await seededStore(redisOptions);
    try {
      await evict(redisOptions, snapshotKeys("run_1").idx);
      // The sibling window command (getSinceCreatedAt) already refuses a lost index. Serving an
      // empty HIT here would report "nothing new" for the rest of the run's life.
      expect(await store.getSince("run_1", "snap_1")).toEqual({ kind: "miss" });
    } finally {
      await store.quit();
    }
  });

  // The property the whole change exists for: whatever the write guard refuses, no read serves.
  redisTest(
    "a keyspace that refuses a transition serves no read either",
    async ({ redisOptions }) => {
      for (const anchor of ["e", "seq"] as const) {
        const runId = `run_coherence_${anchor}`;
        const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
        try {
          await store.append({
            entry: entry({ id: "snap_1", runId }),
            kind: "birth",
            isTerminal: false,
          });
          await evict(redisOptions, snapshotKeys(runId)[anchor]);

          const write = await store.append({
            entry: entry({ id: "snap_2", runId }),
            kind: "transition",
            isTerminal: false,
          });
          expect(write).toEqual({ outcome: "skippedNoKeyspace" });

          expect(await store.getLatest(runId)).toBeNull();
          expect(await store.getById(runId, "snap_1")).toBeNull();
          expect(await store.getSnapshotWaitpointIds(runId, "snap_1")).toMatchObject({
            present: false,
          });
          expect(await store.getSince(runId, "snap_1")).toEqual({ kind: "miss" });
          expect(
            await store.getSinceCreatedAt(runId, "2026-08-20T00:00:00.000Z")
          ).toEqual({ kind: "miss" });
        } finally {
          await store.quit();
        }
      }
    }
  );
});
