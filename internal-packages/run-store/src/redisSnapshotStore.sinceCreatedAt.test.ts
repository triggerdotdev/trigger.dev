// getExecutionSnapshotsSince resolves its cursor to a createdAt before it asks for the window, so
// the snapshot id is gone by then and getSince cannot serve it. This read takes the cursor instead,
// and has to agree with the Postgres read it stands in for — same-millisecond blind spot included.
import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import type { SnapshotEntryInput } from "./redisSnapshotStore.js";

const COMPLETED_TTL_MS = 72 * 60 * 60 * 1000;

function entry(runId: string, id: string, createdAt: string): SnapshotEntryInput {
  return {
    id,
    engine: "V2",
    executionStatus: "EXECUTING",
    description: "d",
    runId,
    runStatus: "EXECUTING",
    createdAt,
    environmentId: "env_1",
    environmentType: "DEVELOPMENT",
    projectId: "proj_1",
    organizationId: "org_1",
  };
}

const at = (seconds: number) =>
  new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

async function seed(
  store: RedisSnapshotStore,
  runId: string,
  stamps: { id: string; createdAt: string }[]
): Promise<void> {
  for (const [index, stamp] of stamps.entries()) {
    await store.append({
      entry: entry(runId, stamp.id, stamp.createdAt),
      kind: index === 0 ? "birth" : "transition",
      isTerminal: false,
    });
  }
}

describe("getSinceCreatedAt", () => {
  redisTest("returns only entries newer than the cursor, oldest first", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
    try {
      const runId = "run_window";
      await seed(
        store,
        runId,
        [0, 1, 2, 3, 4].map((n) => ({ id: `snap_${n}`, createdAt: at(n) }))
      );

      const result = await store.getSinceCreatedAt(runId, at(1));

      expect(result.kind).toBe("hit");
      if (result.kind !== "hit") return;
      // Ascending, matching what the engine hands its caller after its own reverse().
      expect(result.entries.map((e) => e.id)).toEqual(["snap_2", "snap_3", "snap_4"]);
    } finally {
      await store.quit();
    }
  });

  redisTest("misses when the run has no keyspace", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
    try {
      // A miss is the coexistence path: the caller falls back to Postgres for a pre-cutover run.
      expect((await store.getSinceCreatedAt("run_absent", at(0))).kind).toBe("miss");
    } finally {
      await store.quit();
    }
  });

  redisTest("returns an empty hit when nothing is newer", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
    try {
      const runId = "run_nothing_newer";
      await seed(store, runId, [{ id: "snap_0", createdAt: at(0) }]);

      const result = await store.getSinceCreatedAt(runId, at(5));

      // A hit, not a miss: Redis owns this run, so the caller must not fall back and re-read
      // Postgres for a window it already answered.
      expect(result.kind).toBe("hit");
      if (result.kind !== "hit") return;
      expect(result.entries).toEqual([]);
    } finally {
      await store.quit();
    }
  });

  redisTest("drops a same-millisecond neighbour, as Postgres does", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
    try {
      const runId = "run_same_ms";
      const shared = at(1);
      await seed(store, runId, [
        { id: "snap_0", createdAt: at(0) },
        { id: "snap_1a", createdAt: shared },
        { id: "snap_1b", createdAt: shared },
        { id: "snap_2", createdAt: at(2) },
      ]);

      const result = await store.getSinceCreatedAt(runId, shared);

      // Postgres serves this window with `createdAt: { gt: cursor }`, which drops both same-ms
      // entries. Returning snap_1b here would be more correct than Postgres and would therefore
      // read as divergence in compare mode.
      expect(result.kind).toBe("hit");
      if (result.kind !== "hit") return;
      expect(result.entries.map((e) => e.id)).toEqual(["snap_2"]);
    } finally {
      await store.quit();
    }
  });

  redisTest("caps the window at the limit, keeping the newest", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
    try {
      const runId = "run_capped";
      await seed(
        store,
        runId,
        Array.from({ length: 60 }, (_, n) => ({ id: `snap_${n}`, createdAt: at(n) }))
      );

      const result = await store.getSinceCreatedAt(runId, at(0), { limit: 50 });

      expect(result.kind).toBe("hit");
      if (result.kind !== "hit") return;
      expect(result.entries).toHaveLength(50);
      // The engine takes the NEWEST 50 and reverses, so the window ends at the newest entry.
      expect(result.entries[result.entries.length - 1]!.id).toBe("snap_59");
      expect(result.entries[0]!.id).toBe("snap_10");
    } finally {
      await store.quit();
    }
  });

  redisTest("scans no further than the answer", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
    try {
      const runId = "run_deep_history";
      await seed(
        store,
        runId,
        Array.from({ length: 400 }, (_, n) => ({ id: `snap_${n}`, createdAt: at(n) }))
      );

      const started = Date.now();
      const result = await store.getSinceCreatedAt(runId, at(394), { limit: 50 });
      const elapsed = Date.now() - started;

      expect(result.kind).toBe("hit");
      if (result.kind !== "hit") return;
      expect(result.entries.map((e) => e.id)).toEqual([
        "snap_395",
        "snap_396",
        "snap_397",
        "snap_398",
        "snap_399",
      ]);
      // The walk stops at the cursor rather than reading the run's history. The bound is generous
      // on purpose: it fails on a full scan of 400 entries, not on ordinary timing noise.
      expect(elapsed).toBeLessThan(1_000);
    } finally {
      await store.quit();
    }
  });

  redisTest("scopes the window to an environment", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
    try {
      const runId = "run_env_scoped";
      await seed(store, runId, [
        { id: "snap_0", createdAt: at(0) },
        { id: "snap_1", createdAt: at(1) },
      ]);

      const foreign = await store.getSinceCreatedAt(runId, at(0), { environmentId: "env_other" });

      expect(foreign.kind).toBe("hit");
      if (foreign.kind !== "hit") return;
      expect(foreign.entries).toEqual([]);
    } finally {
      await store.quit();
    }
  });
});
