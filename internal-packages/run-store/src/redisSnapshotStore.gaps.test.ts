// A5. The repair restores the head but not the entries lost in the fork window, so a keyspace ends up
// with a hole in the middle and a correct head. That is invisible at dual-write, where Postgres is
// authoritative and the engine reads the head. It is not invisible at redis-read: the window read
// serves a since-createdAt range straight from Redis, and its guards (a miss, a dangling cycle)
// cannot see a HOLE, so a window that should hold eight entries returns four with nothing logged. A
// history that is short rather than wrong is the harder kind to notice.
//
// Backfilling the lost entries is NOT the fix and would be worse. A late append takes a fresh seq
// from HINCRBY, and both window scripts walk the index in seq order treating it as time order,
// stopping at the first entry past the cursor. A backfilled old entry with a high seq would truncate
// the window harder than the hole does.
//
// So the keyspace records that its history is untrustworthy and windows refuse, which routes the
// caller through its existing miss path to Postgres. Point reads stay Redis-served, because the
// repair does guarantee the head converges.
import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { RedisSnapshotStore, snapshotKeys } from "./redisSnapshotStore.js";
import type { SnapshotEntryInput } from "./redisSnapshotStore.js";
import { createRedisClient } from "@internal/redis";

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

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

async function seed(store: RedisSnapshotStore, runId: string, count: number): Promise<void> {
  for (let n = 0; n < count; n++) {
    await store.append({
      entry: entry(runId, `snap_${n}`, at(n)),
      kind: n === 0 ? "birth" : "transition",
      isTerminal: false,
    });
  }
}

describe("the gaps marker", () => {
  redisTest(
    "is unset on a healthy keyspace, which still serves its window",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      try {
        const runId = "run_healthy";
        await seed(store, runId, 5);

        expect(await store.hasGaps(runId)).toBe(false);
        expect((await store.getSinceCreatedAt(runId, at(1))).kind).toBe("hit");
        expect((await store.getSince(runId, "snap_1")).kind).toBe("hit");
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("makes BOTH window reads refuse, so each falls back", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
    try {
      const runId = "run_holed";
      await seed(store, runId, 5);

      // What a repair does when it lands: the head is right, the window is not to be trusted.
      await store.markGaps(runId);
      expect(await store.hasGaps(runId)).toBe(true);

      // Both window commands, because a caller that fell back on one and not the other would still
      // serve a short history through the second.
      expect((await store.getSinceCreatedAt(runId, at(1))).kind).toBe("miss");
      expect((await store.getSince(runId, "snap_1")).kind).toBe("miss");
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "leaves point reads alone, because the repair converges the head",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      try {
        const runId = "run_point";
        await seed(store, runId, 5);
        await store.markGaps(runId);

        // The head is the engine's hot read and the repair guarantees it. Refusing it would send every
        // transition of a once-forked run to Postgres for the rest of its life.
        const head = await store.getLatest(runId);
        expect(head?.entry.id).toBe("snap_4");

        const byId = await store.getById(runId, "snap_2");
        expect(byId?.entry.id).toBe("snap_2");
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "is set by a fork, which is direct evidence of divergence",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      try {
        const runId = "run_forked";
        await seed(store, runId, 3);

        const result = await store.append({
          entry: entry(runId, "snap_late", at(9)),
          kind: "transition",
          isTerminal: false,
          expectedCur: "snap_wrong",
        });

        expect(result.outcome).toBe("forked");
        // A fork means this keyspace and Postgres already disagree about the head, so whatever the
        // repair does later, the window between them is not trustworthy now.
        expect(await store.hasGaps(runId)).toBe(true);
        expect((await store.getSinceCreatedAt(runId, at(1))).kind).toBe("miss");
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "dies with the keyspace rather than needing its own expiry",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const runId = "run_ttl";
        await seed(store, runId, 3);
        await store.markGaps(runId);

        // The marker is a field on the seq hash, so the completion expiry that governs the keyspace
        // governs it too. No second lifetime to get wrong.
        expect(await probe.hget(snapshotKeys(runId).seq, "g")).toBe("1");
        await store.dropRun(runId);
        expect(await probe.exists(snapshotKeys(runId).seq)).toBe(0);
      } finally {
        await Promise.all([store.quit(), probe.quit().catch(() => {})]);
      }
    }
  );
  redisTest(
    "a lone seq key is never created for a run that has no keyspace",
    async ({ redisOptions }) => {
      // markGaps writes a field on the seq hash, and HSET creates the hash if it is absent. For a
      // run with no keyspace that would leave a stray seq key holding only the marker: keyspaceAlive
      // stays false so no read is affected, but the sweeper scans on the entry hash and would never
      // discover it, so it would never be reaped either. An unbounded leak with no reader.
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const runId = "run_never_born";
        expect(await store.markGapsIfResident(runId)).toBe(false);
        expect(await probe.exists(snapshotKeys(runId).seq)).toBe(0);

        await seed(store, runId, 2);
        expect(await store.markGapsIfResident(runId)).toBe(true);
        expect(await store.hasGaps(runId)).toBe(true);
      } finally {
        await Promise.all([store.quit(), probe.quit().catch(() => {})]);
      }
    }
  );
  redisTest(
    "a transition that finds the index gone marks the history, rather than rebuilding a partial one",
    async ({ redisOptions }) => {
      // keyspaceAlive tests the entry hash and seq, not the index. An index lost while those two
      // survive used to let the next transition recreate it holding only that entry, and a window
      // read would then see a live index, report a hit, and return one entry as the whole range.
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const runId = "run_index_lost";
        await seed(store, runId, 4);
        expect(await store.hasGaps(runId)).toBe(false);

        // Lose the index only, the way a per-key expiry or eviction would.
        await probe.del(snapshotKeys(runId).idx);
        expect(await probe.exists(snapshotKeys(runId).e)).toBe(1);

        await store.append({
          entry: entry(runId, "snap_after_loss", at(9)),
          kind: "transition",
          isTerminal: false,
        });

        // The index is back, holding one entry, which is exactly the trap.
        expect(await probe.exists(snapshotKeys(runId).idx)).toBe(1);
        // So the keyspace is marked and the window refuses instead of serving a one-entry range.
        expect(await store.hasGaps(runId)).toBe(true);
        expect((await store.getSinceCreatedAt(runId, at(1))).kind).toBe("miss");

        // The head still moves: refusing the transition would have frozen it.
        expect((await store.getLatest(runId))?.entry.id).toBe("snap_after_loss");
      } finally {
        await Promise.all([store.quit(), probe.quit().catch(() => {})]);
      }
    }
  );

  redisTest(
    "dropping a run removes its wait cycle keys even when seq is already gone",
    async ({ redisOptions }) => {
      // The cycle count lives on seq, so seq being absent read as zero cycles and left every wait
      // cycle key behind, while dropRun claimed to remove the whole keyspace. The sweep cannot see
      // those either: it discovers keyspaces by the entry hash.
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: COMPLETED_TTL_MS });
      const probe = createRedisClient(redisOptions, { onError: () => {} });
      try {
        const runId = "run_orphan_cycles";
        // Derived, never hardcoded: snapshotKeys returns UNPREFIXED keys and the `engine:` prefix is
        // the client's, which testcontainers do not set. A literal prefix here creates keys the
        // script never looks at, and the test passes or fails for the wrong reason.
        const eKey = snapshotKeys(runId).e;
        const base = eKey.slice(0, -2);
        await seed(store, runId, 2);

        // Wait cycle keys as the append script writes them, then lose seq.
        await probe.hset(`${base}:wp:1`, "order", "[]", "count", "0", "distinct", "[]");
        await probe.hset(`${base}:wp:2`, "order", "[]", "count", "0", "distinct", "[]");
        await probe.del(snapshotKeys(runId).seq);

        await store.dropRun(runId);

        for (const key of [`${base}:wp:1`, `${base}:wp:2`]) {
          expect(await probe.exists(key)).toBe(0);
        }
        for (const key of Object.values(snapshotKeys(runId))) {
          expect(await probe.exists(key)).toBe(0);
        }
      } finally {
        await Promise.all([store.quit(), probe.quit().catch(() => {})]);
      }
    }
  );
});
