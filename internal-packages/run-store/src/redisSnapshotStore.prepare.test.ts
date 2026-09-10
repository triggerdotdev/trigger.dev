// M3: the prepare / finalize / abortPrepared transition state machine over the M2-locked layout.
// Real Redis (testcontainers), no mocks. Cluster slot behaviour is proven separately in
// redisSnapshotStore.cluster.test.ts.
import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import {
  RedisSnapshotStore,
  type CompletedWaitpointRecord,
  type PreparedEntry,
  type PreparedPgUnit,
  type SnapshotEntryInput,
} from "./redisSnapshotStore.js";
import {
  preparedUnitKey,
  pendingStreamKeyForRun,
  residencyKey,
  snapshotKeys,
} from "./snapshotKeys.js";
import { PendingIndex } from "./pendingIndex.js";

function entry(
  over: Partial<SnapshotEntryInput> & { id: string; runId: string }
): SnapshotEntryInput {
  return {
    engine: "V2",
    executionStatus: "EXECUTING",
    description: "d",
    runStatus: "EXECUTING",
    createdAt: "2026-08-21T00:00:00.000Z",
    environmentId: "env_1",
    environmentType: "PRODUCTION",
    projectId: "proj_1",
    organizationId: "org_1",
    ...over,
  };
}

function staged(runId: string, id: string, over: Partial<PreparedEntry> = {}): PreparedEntry {
  return {
    entry: entry({ id, runId }),
    kind: "transition",
    isTerminal: false,
    ...over,
  };
}

function unit(
  runId: string,
  entries: PreparedEntry[],
  over: Partial<PreparedPgUnit> = {}
): PreparedPgUnit {
  return {
    protocolVersion: 1,
    transitionToken: "tok_1",
    postgresXid: "42",
    runId,
    organizationId: "org_1",
    residency: "mirrored",
    logicalRunStoreRoute: "logical:1",
    entries,
    ...over,
  };
}

// Give a run a committed head via the ordinary append path, so a prepared transition has something
// to guard against, exactly as a mid-life mirrored transition would.
async function bornRun(store: RedisSnapshotStore, runId: string, headId = "s0"): Promise<void> {
  await store.append({ entry: entry({ id: headId, runId }), kind: "birth", isTerminal: false });
}

describe("prepare", () => {
  redisTest(
    "a head fork during prepare is rejected without gapping the keyspace, leaving the committed head readable",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_prepare_fork";
        await bornRun(store, runId, "s0"); // committed head s0

        const result = await store.prepare(
          unit(runId, [staged(runId, "s1", { expectedCur: "s_stale" })])
        );
        expect(result.outcome).toBe("forkGuard");

        // The guard runs before any Postgres commit and the rejected transaction rolls back, so the
        // fork must NOT gap the keyspace: no prepared unit is staged, no gap is marked, and the
        // previously committed head stays readable.
        expect(await store.hasPreparedUnit(runId)).toBe(false);
        expect(await store.hasGaps(runId)).toBe(false);
        expect((await store.getLatest(runId))?.entry.id).toBe("s0");
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("stages a hidden unit and a pending-index entry", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const raw = createRedisClient(redisOptions);
    try {
      const runId = "run_prep_hidden";
      await bornRun(store, runId);

      const r = await store.prepare(
        unit(runId, [
          staged(runId, "s1", { expectedCur: "s0" }),
          staged(runId, "s2", { expectedCur: "s1" }),
        ])
      );
      expect(r.outcome).toBe("prepared");

      // The staged entries are NOT visible to reads: the head is still the committed birth.
      expect((await store.getLatest(runId))?.id).toBe("s0");
      expect(await store.getById(runId, "s1")).toBeNull();
      expect(await store.getById(runId, "s2")).toBeNull();

      // The prep key holds the whole unit; a pending-index entry exists for the run's partition.
      const prep = await raw.hgetall(preparedUnitKey(runId));
      expect(prep.token).toBe("tok_1");
      expect(JSON.parse(prep.unit).postgresXid).toBe("42");

      const pending = await new PendingIndex(raw).enumerate(
        Number(preparedUnitKey(runId).match(/\{p(\d+)\}/)![1])
      );
      expect(pending.map((p) => p.fields.runId)).toContain(runId);
    } finally {
      await raw.quit();
      await store.quit();
    }
  });

  redisTest("a different token while one is pending returns busy", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_prep_busy";
      await bornRun(store, runId);
      expect(
        (await store.prepare(unit(runId, [staged(runId, "s1")], { transitionToken: "a" }))).outcome
      ).toBe("prepared");
      const busy = await store.prepare(
        unit(runId, [staged(runId, "s2")], { transitionToken: "b" })
      );
      expect(busy).toEqual({ outcome: "busy" });
      // The original pending unit is untouched.
      const finalized = await store.finalize(runId, "a");
      expect(finalized).toMatchObject({ outcome: "finalized", head: "s1" });
    } finally {
      await store.quit();
    }
  });

  redisTest("the same token with an identical unit is idempotent", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const raw = createRedisClient(redisOptions);
    try {
      const runId = "run_prep_idem";
      await bornRun(store, runId);
      const u = unit(runId, [staged(runId, "s1", { expectedCur: "s0" })]);
      const first = await store.prepare(u);
      expect(first.outcome).toBe("prepared");
      const second = await store.prepare(u);
      expect(second.outcome).toBe("idempotent");
      if (first.outcome !== "prepared" || second.outcome !== "idempotent") throw new Error("x");
      // No second XADD: the stream id is the original, and there is exactly one pending entry.
      expect(second.streamId).toBe(first.streamId);
      const len = await raw.xlen(pendingStreamKeyForRun(runId));
      expect(len).toBe(1);
    } finally {
      await raw.quit();
      await store.quit();
    }
  });

  redisTest("the same token with different data is a conflict", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_prep_conflict";
      await bornRun(store, runId);
      await store.prepare(unit(runId, [staged(runId, "s1")], { transitionToken: "t" }));
      const r = await store.prepare(
        unit(
          runId,
          [staged(runId, "s1", { entry: entry({ id: "s1", runId, description: "changed" }) })],
          {
            transitionToken: "t",
          }
        )
      );
      expect(r).toEqual({ outcome: "conflict" });
    } finally {
      await store.quit();
    }
  });

  redisTest("rejects a multi-run unit", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_prep_multi";
      await bornRun(store, runId);
      await expect(
        store.prepare(unit(runId, [staged(runId, "s1"), staged("run_other", "s2")]))
      ).rejects.toThrow(/exactly one run/i);
    } finally {
      await store.quit();
    }
  });
});

describe("prepare fork guard", () => {
  redisTest("the first guarded entry checks the committed head", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const ok = "run_fg_ok";
      await bornRun(store, ok);
      expect(
        (await store.prepare(unit(ok, [staged(ok, "s1", { expectedCur: "s0" })]))).outcome
      ).toBe("prepared");

      const bad = "run_fg_bad";
      await bornRun(store, bad);
      const r = await store.prepare(unit(bad, [staged(bad, "s1", { expectedCur: "wrong" })]));
      expect(r).toEqual({ outcome: "forkGuard", reason: "head", actualCur: "s0" });
      // Rejected: nothing staged, nothing pending.
      expect(await store.getById(bad, "s1")).toBeNull();
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "each subsequent guarded entry checks its predecessor's staged id",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_fg_chain";
        await bornRun(store, runId);
        const good = await store.prepare(
          unit(runId, [
            staged(runId, "s1", { expectedCur: "s0" }),
            staged(runId, "s2", { expectedCur: "s1" }),
            staged(runId, "s3", { expectedCur: "s2" }),
          ])
        );
        expect(good.outcome).toBe("prepared");
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("a broken guarded chain is rejected", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_fg_broken";
      await bornRun(store, runId);
      const r = await store.prepare(
        unit(runId, [
          staged(runId, "s1", { expectedCur: "s0" }),
          // s2 asserts a head that is not its predecessor s1: broken chain.
          staged(runId, "s2", { expectedCur: "s0" }),
        ])
      );
      expect(r).toEqual({ outcome: "forkGuard", reason: "chain", index: 1 });
      // Rejected before touching Redis: no pending unit.
      expect((await store.finalize(runId, "tok_1")).outcome).toBe("noop");
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "an unguarded entry follows existing unconditional semantics",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_fg_unguarded";
        await bornRun(store, runId);
        // No expectedCur anywhere: never rejected regardless of the committed head.
        expect(
          (await store.prepare(unit(runId, [staged(runId, "s1"), staged(runId, "s2")]))).outcome
        ).toBe("prepared");
        expect((await store.finalize(runId, "tok_1")).outcome).toBe("finalized");
      } finally {
        await store.quit();
      }
    }
  );
});

describe("finalize", () => {
  redisTest(
    "publishes all ordered entries atomically and advances the head",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions);
      try {
        const runId = "run_fin_publish";
        await bornRun(store, runId);
        await store.prepare(
          unit(runId, [
            staged(runId, "s1", { expectedCur: "s0" }),
            staged(runId, "s2", { expectedCur: "s1" }),
            staged(runId, "s3", { expectedCur: "s2" }),
          ])
        );

        const r = await store.finalize(runId, "tok_1");
        expect(r).toEqual({ outcome: "finalized", head: "s3" });
        expect((await store.getLatest(runId))?.id).toBe("s3");

        const since = await store.getSince(runId, "s0");
        if (since.kind !== "hit") throw new Error("expected a hit");
        expect(since.entries.map((e) => e.id)).toEqual(["s1", "s2", "s3"]);
        // Pending is cleared: prep key gone, no pending-index entry.
        expect(await raw.exists(preparedUnitKey(runId))).toBe(0);
        expect(await raw.xlen(pendingStreamKeyForRun(runId))).toBe(0);
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );

  redisTest(
    "carries cycle records through so a read reproduces the Postgres read",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_fin_cycle";
        await bornRun(store, runId);
        const records: CompletedWaitpointRecord[] = [
          {
            id: "w_a",
            friendlyId: "waitpoint_a",
            type: "RUN",
            completedAt: "2026-01-01T00:00:00.000Z",
            outputType: "application/json",
            outputIsError: false,
            output: { inline: "hello" },
          },
        ];
        await store.prepare(
          unit(runId, [
            staged(runId, "s1", {
              expectedCur: "s0",
              cycle: { kind: "new", completedWaitpoints: [{ id: "w_a", index: 0 }], records },
            }),
          ])
        );
        await store.finalize(runId, "tok_1");

        const ids = await store.getSnapshotWaitpointIds(runId, "s1");
        expect(ids).toEqual({ present: true, distinctIds: ["w_a"], order: ["w_a"] });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("is idempotent and lost-reply-safe", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_fin_idem";
      await bornRun(store, runId);
      await store.prepare(unit(runId, [staged(runId, "s1", { expectedCur: "s0" })]));
      expect(await store.finalize(runId, "tok_1")).toEqual({ outcome: "finalized", head: "s1" });
      // A repeat after completion is a no-op success, and does not re-apply the entry.
      expect(await store.finalize(runId, "tok_1")).toEqual({ outcome: "noop" });
      expect((await store.getLatest(runId))?.seq).toBe(2);
    } finally {
      await store.quit();
    }
  });

  redisTest("a stale token does not finalize a newer pending unit", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_fin_stale";
      await bornRun(store, runId);
      await store.prepare(
        unit(runId, [staged(runId, "s1", { expectedCur: "s0" })], { transitionToken: "new" })
      );
      // A stale finalize with the wrong token must leave the pending unit intact.
      expect(await store.finalize(runId, "old")).toEqual({ outcome: "stale" });
      expect((await store.getLatest(runId))?.id).toBe("s0");
      expect(await store.finalize(runId, "new")).toMatchObject({
        outcome: "finalized",
        head: "s1",
      });
    } finally {
      await store.quit();
    }
  });
});

describe("abortPrepared", () => {
  redisTest("a matching token clears the pending unit", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const raw = createRedisClient(redisOptions);
    try {
      const runId = "run_abort_match";
      await bornRun(store, runId);
      await store.prepare(
        unit(runId, [staged(runId, "s1", { expectedCur: "s0" })], { transitionToken: "t" })
      );
      expect(await store.abortPrepared(runId, "t")).toEqual({ outcome: "aborted" });
      expect(await raw.exists(preparedUnitKey(runId))).toBe(0);
      expect(await raw.xlen(pendingStreamKeyForRun(runId))).toBe(0);
      // Head unchanged, and the run is free to prepare again.
      expect((await store.getLatest(runId))?.id).toBe("s0");
      expect(
        (await store.prepare(unit(runId, [staged(runId, "s1", { expectedCur: "s0" })]))).outcome
      ).toBe("prepared");
    } finally {
      await raw.quit();
      await store.quit();
    }
  });

  redisTest(
    "a stale token is a no-op and a newer transition survives it",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_abort_stale";
        await bornRun(store, runId);
        await store.prepare(
          unit(runId, [staged(runId, "s1", { expectedCur: "s0" })], { transitionToken: "new" })
        );
        // The stale abort must NOT clear the newer transition.
        expect(await store.abortPrepared(runId, "old")).toEqual({ outcome: "stale" });
        expect(await store.finalize(runId, "new")).toMatchObject({
          outcome: "finalized",
          head: "s1",
        });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("is a no-op when nothing is pending", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_abort_none";
      await bornRun(store, runId);
      expect(await store.abortPrepared(runId, "t")).toEqual({ outcome: "noop" });
    } finally {
      await store.quit();
    }
  });
});

describe("key durability", () => {
  redisTest("prep and pending keys never expire while pending", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const raw = createRedisClient(redisOptions);
    try {
      const runId = "run_dur_pending";
      await bornRun(store, runId);
      await store.prepare(unit(runId, [staged(runId, "s1", { expectedCur: "s0" })]));
      expect(await raw.pttl(preparedUnitKey(runId))).toBe(-1);
      expect(await raw.pttl(pendingStreamKeyForRun(runId))).toBe(-1);
    } finally {
      await raw.quit();
      await store.quit();
    }
  });

  redisTest(
    "a birth finalize stamps the residency marker with no TTL",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions);
      try {
        const runId = "run_dur_birth";
        await store.prepare(
          unit(runId, [staged(runId, "b0", { kind: "birth" })], {
            residency: "redis-primary",
            transitionToken: "birth",
          })
        );
        expect(await store.getLatest(runId)).toBeNull(); // hidden until finalize
        await store.finalize(runId, "birth");

        expect((await store.getLatest(runId))?.id).toBe("b0");
        expect(await raw.get(residencyKey(runId))).toBe("redis-primary");
        expect(await raw.pttl(residencyKey(runId))).toBe(-1);
        // Non-terminal, so the run keys are unexpiring too.
        expect(await raw.pttl(snapshotKeys(runId).e)).toBe(-1);
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );

  redisTest(
    "a terminal finalize applies the TTL to run keys, leaving the marker no-TTL",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions);
      try {
        const runId = "run_dur_terminal";
        await store.prepare(
          unit(runId, [staged(runId, "b0", { kind: "birth" })], {
            residency: "redis-primary",
            transitionToken: "birth",
          })
        );
        await store.finalize(runId, "birth");

        await store.prepare(
          unit(
            runId,
            [
              staged(runId, "t1", {
                expectedCur: "b0",
                isTerminal: true,
                entry: entry({ id: "t1", runId, executionStatus: "FINISHED" }),
              }),
            ],
            { transitionToken: "term" }
          )
        );
        await store.finalize(runId, "term");

        for (const key of [
          snapshotKeys(runId).e,
          snapshotKeys(runId).idx,
          snapshotKeys(runId).cur,
          snapshotKeys(runId).seq,
        ]) {
          const ttl = await raw.pttl(key);
          expect(ttl).toBeGreaterThan(0);
          expect(ttl).toBeLessThanOrEqual(60_000);
        }
        // The residency marker is the load-bearing no-TTL exception.
        expect(await raw.pttl(residencyKey(runId))).toBe(-1);
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );
});
