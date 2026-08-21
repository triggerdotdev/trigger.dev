// Unit suite for the raw Redis execution-snapshot store. Redis-only: the store holds no Prisma
// reference, so no Postgres container is needed.
import { expect, describe } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import {
  snapshotKeys,
  deriveOrder,
  isValidFor,
  RedisSnapshotStore,
  type SnapshotEntryInput,
} from "./redisSnapshotStore.js";

describe("snapshotKeys", () => {
  it("puts every core key under one hash tag", () => {
    const k = snapshotKeys("run_abc123");
    expect(k.e).toBe("snap:{run_abc123}:e");
    expect(k.idx).toBe("snap:{run_abc123}:idx");
    expect(k.cur).toBe("snap:{run_abc123}:cur");
    expect(k.seq).toBe("snap:{run_abc123}:seq");
  });
});

describe("deriveOrder", () => {
  it("drops entries with no index, sorts by index, and maps to id", () => {
    expect(
      deriveOrder([
        { id: "w_c", index: 2 },
        { id: "w_a", index: 0 },
        { id: "w_no" },
        { id: "w_b", index: 1 },
      ])
    ).toEqual(["w_a", "w_b", "w_c"]);
  });

  it("preserves a repeated id at each of its positions", () => {
    expect(
      deriveOrder([
        { id: "w_x", index: 0 },
        { id: "w_x", index: 1 },
      ])
    ).toEqual(["w_x", "w_x"]);
  });

  it("returns an empty list when nothing carries an index", () => {
    expect(deriveOrder([{ id: "w_a" }, { id: "w_b" }])).toEqual([]);
  });
});

describe("isValidFor", () => {
  it("is false when the entry carries an error and true otherwise", () => {
    expect(isValidFor({ error: "boom" })).toBe(false);
    expect(isValidFor({})).toBe(true);
    expect(isValidFor({ error: undefined })).toBe(true);
  });
});

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

describe("append", () => {
  redisTest("assigns a monotonic seq and reads the entry back by id", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 72 * 3600 * 1000 });
    try {
      const a = await store.append({
        entry: entry({ id: "snap_1" }),
        kind: "birth",
        isTerminal: false,
      });
      const b = await store.append({
        entry: entry({ id: "snap_2" }),
        kind: "transition",
        isTerminal: false,
      });
      expect(a).toMatchObject({ outcome: "written", seq: 1 });
      expect(b).toMatchObject({ outcome: "written", seq: 2 });

      const read = await store.getById("run_1", "snap_2");
      expect(read?.seq).toBe(2);
      expect(read?.isValid).toBe(true);
      expect(read?.entry.description).toBe("created");
    } finally {
      await store.quit();
    }
  });

  redisTest("preserves the entry JSON byte for byte", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      const e = entry({ id: "snap_1", metadata: { empty: [], nested: { a: 1 } } });
      await store.append({ entry: e, kind: "birth", isTerminal: false });
      const read = await store.getById("run_1", "snap_1");
      expect(read?.raw).toBe(JSON.stringify(e));
      expect(read?.entry).toEqual(e);
    } finally {
      await store.quit();
    }
  });

  redisTest("advances cur only for a valid entry", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "snap_1" }), kind: "birth", isTerminal: false });
      await store.append({
        entry: entry({ id: "snap_bad", error: "nope" }),
        kind: "transition",
        isTerminal: false,
      });
      const latest = await store.getLatest("run_1");
      expect(latest?.id).toBe("snap_1");

      const invalid = await store.getById("run_1", "snap_bad");
      expect(invalid?.isValid).toBe(false);
    } finally {
      await store.quit();
    }
  });

  redisTest("skips a transition against an absent keyspace", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      const r = await store.append({
        entry: entry({ id: "snap_1", runId: "run_never" }),
        kind: "transition",
        isTerminal: false,
      });
      expect(r).toEqual({ outcome: "skippedNoKeyspace" });
      expect(await store.getLatest("run_never")).toBeNull();

      const k = snapshotKeys("run_never");
      const raw = createRedisClient(redisOptions);
      try {
        expect(await raw.exists(k.e, k.idx, k.cur, k.seq)).toBe(0);
      } finally {
        await raw.quit();
      }
    } finally {
      await store.quit();
    }
  });

  redisTest("skips a transition when only the seq key has expired", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "snap_1" }), kind: "birth", isTerminal: false });

      const k = snapshotKeys("run_1");
      const raw = createRedisClient(redisOptions);
      try {
        await raw.del(k.seq);
      } finally {
        await raw.quit();
      }

      const r = await store.append({
        entry: entry({ id: "snap_2" }),
        kind: "transition",
        isTerminal: false,
      });
      expect(r).toEqual({ outcome: "skippedNoKeyspace" });
    } finally {
      await store.quit();
    }
  });

  // Pairs with "skips a transition when only the seq key has expired" above: liveness is checked
  // against BOTH anchors, so either one missing alone must skip.
  redisTest("skips a transition when only the e key has expired", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "snap_1" }), kind: "birth", isTerminal: false });

      const k = snapshotKeys("run_1");
      const raw = createRedisClient(redisOptions);
      try {
        await raw.del(k.e);
      } finally {
        await raw.quit();
      }

      const r = await store.append({
        entry: entry({ id: "snap_2" }),
        kind: "transition",
        isTerminal: false,
      });
      expect(r).toEqual({ outcome: "skippedNoKeyspace" });
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "carries the original count forward on a carryForward append",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      try {
        await store.append({
          entry: entry({ id: "snap_1" }),
          kind: "birth",
          isTerminal: false,
          cycle: {
            kind: "new",
            completedWaitpoints: [
              { id: "w_a", index: 0 },
              { id: "w_b", index: 1 },
            ],
          },
        });
        await store.append({
          entry: entry({ id: "snap_2" }),
          kind: "transition",
          isTerminal: false,
          cycle: { kind: "carryForward", cycleSeq: 1 },
        });

        const read = await store.getById("run_1", "snap_2");
        expect(read?.cycle).toEqual({ cycleSeq: 1, count: 2 });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "reports a duplicate id without overwriting the original entry",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      try {
        const first = await store.append({
          entry: entry({ id: "snap_1", description: "created" }),
          kind: "birth",
          isTerminal: false,
        });
        expect(first).toMatchObject({ outcome: "written", seq: 1 });

        const dup = await store.append({
          entry: entry({ id: "snap_1", description: "different" }),
          kind: "transition",
          isTerminal: false,
        });
        expect(dup).toEqual({ outcome: "duplicate", seq: 1 });

        const read = await store.getById("run_1", "snap_1");
        expect(read?.entry.description).toBe("created");

        const next = await store.append({
          entry: entry({ id: "snap_2" }),
          kind: "transition",
          isTerminal: false,
        });
        expect(next).toMatchObject({ outcome: "written", seq: 2 });
      } finally {
        await store.quit();
      }
    }
  );
});

describe("cycle keys", () => {
  redisTest(
    "mints an increasing cycleSeq across successive new cycles",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      try {
        await store.append({ entry: entry({ id: "snap_1" }), kind: "birth", isTerminal: false });
        const a = await store.append({
          entry: entry({ id: "snap_2" }),
          kind: "transition",
          isTerminal: false,
          cycle: { kind: "new", completedWaitpoints: [{ id: "w_a", index: 0 }] },
        });
        const b = await store.append({
          entry: entry({ id: "snap_3" }),
          kind: "transition",
          isTerminal: false,
          cycle: { kind: "new", completedWaitpoints: [{ id: "w_b", index: 0 }] },
        });
        expect(a).toMatchObject({ cycleSeq: 1 });
        expect(b).toMatchObject({ cycleSeq: 2 });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a carry-forward reuses the cycle and does not rewrite it",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      try {
        await store.append({ entry: entry({ id: "snap_1" }), kind: "birth", isTerminal: false });
        await store.append({
          entry: entry({ id: "snap_2" }),
          kind: "transition",
          isTerminal: false,
          cycle: {
            kind: "new",
            completedWaitpoints: [
              { id: "w_a", index: 0 },
              { id: "w_a", index: 1 },
            ],
          },
        });
        const carried = await store.append({
          entry: entry({ id: "snap_3" }),
          kind: "transition",
          isTerminal: false,
          cycle: { kind: "carryForward", cycleSeq: 1 },
        });
        expect(carried).toMatchObject({ cycleSeq: 1, cycleMismatch: false });

        // Both entries resolve to the SAME cycle contents, written once.
        const first = await store.getSnapshotWaitpointIds("run_1", "snap_2");
        const second = await store.getSnapshotWaitpointIds("run_1", "snap_3");
        expect(first.order).toEqual(["w_a", "w_a"]);
        expect(first.distinctIds).toEqual(["w_a"]);
        expect(second).toEqual(first);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("a carry-forward naming a missing cycle still appends", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "snap_1" }), kind: "birth", isTerminal: false });
      const r = await store.append({
        entry: entry({ id: "snap_2" }),
        kind: "transition",
        isTerminal: false,
        cycle: { kind: "carryForward", cycleSeq: 99 },
      });
      expect(r).toMatchObject({ outcome: "written", cycleMismatch: true });
    } finally {
      await store.quit();
    }
  });

  redisTest("reports presence and emptiness separately", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "snap_1" }), kind: "birth", isTerminal: false });
      expect(await store.getSnapshotWaitpointIds("run_1", "nope")).toEqual({
        present: false,
        distinctIds: [],
        order: [],
      });
      expect(await store.getSnapshotWaitpointIds("run_1", "snap_1")).toEqual({
        present: true,
        distinctIds: [],
        order: [],
      });
    } finally {
      await store.quit();
    }
  });
});

describe("TTL rule", () => {
  redisTest("a non-terminal append leaves every key unexpiring", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const raw = createRedisClient(redisOptions);
    try {
      await store.append({
        entry: entry({ id: "s1" }),
        kind: "birth",
        isTerminal: false,
        cycle: { kind: "new", completedWaitpoints: [{ id: "w_a", index: 0 }] },
      });
      for (const key of [
        "snap:{run_1}:e",
        "snap:{run_1}:idx",
        "snap:{run_1}:cur",
        "snap:{run_1}:seq",
        "snap:{run_1}:wp:1",
      ]) {
        expect(await raw.pttl(key)).toBe(-1);
      }
    } finally {
      await raw.quit();
      await store.quit();
    }
  });

  redisTest(
    "a terminal append expires every key, cycle keys included",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions);
      try {
        await store.append({
          entry: entry({ id: "s1" }),
          kind: "birth",
          isTerminal: false,
          cycle: { kind: "new", completedWaitpoints: [{ id: "w_a", index: 0 }] },
        });
        // Second cycle, so the terminal PEXPIRE loop runs past its first iteration.
        await store.append({
          entry: entry({ id: "s1b" }),
          kind: "transition",
          isTerminal: false,
          cycle: { kind: "new", completedWaitpoints: [{ id: "w_b", index: 0 }] },
        });
        const r = await store.append({
          entry: entry({ id: "s2", executionStatus: "FINISHED" }),
          kind: "transition",
          isTerminal: true,
        });
        expect(r).toMatchObject({ ttl: "completion" });
        for (const key of [
          "snap:{run_1}:e",
          "snap:{run_1}:idx",
          "snap:{run_1}:cur",
          "snap:{run_1}:seq",
          "snap:{run_1}:wp:1",
          "snap:{run_1}:wp:2",
        ]) {
          const ttl = await raw.pttl(key);
          expect(ttl).toBeGreaterThan(0);
          expect(ttl).toBeLessThanOrEqual(60_000);
        }
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );

  redisTest("a post-completion append re-applies the completion TTL", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const raw = createRedisClient(redisOptions);
    try {
      await store.append({
        entry: entry({ id: "s1" }),
        kind: "birth",
        isTerminal: false,
        cycle: { kind: "new", completedWaitpoints: [{ id: "w_a", index: 0 }] },
      });
      await store.append({
        entry: entry({ id: "s1b" }),
        kind: "transition",
        isTerminal: false,
        cycle: { kind: "new", completedWaitpoints: [{ id: "w_b", index: 0 }] },
      });
      await store.append({
        entry: entry({ id: "s2", executionStatus: "FINISHED" }),
        kind: "transition",
        isTerminal: true,
      });

      const keys = [
        "snap:{run_1}:e",
        "snap:{run_1}:idx",
        "snap:{run_1}:cur",
        "snap:{run_1}:seq",
        "snap:{run_1}:wp:1",
        "snap:{run_1}:wp:2",
      ];
      // Shrink first: a re-apply is then the only way the TTL can go back up.
      for (const key of keys) {
        await raw.pexpire(key, 5_000);
      }

      // A stale client appends a non-terminal, invalid row after FINISHED.
      const late = await store.append({
        entry: entry({ id: "s3", error: "stale" }),
        kind: "transition",
        isTerminal: false,
      });
      expect(late).toMatchObject({ outcome: "written", ttl: "reapplied" });
      for (const key of keys) {
        const ttl = await raw.pttl(key);
        expect(ttl).toBeGreaterThan(55_000);
        expect(ttl).toBeLessThanOrEqual(60_000);
      }
    } finally {
      await raw.quit();
      await store.quit();
    }
  });

  redisTest("a transition after the keyspace expired writes nothing", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const raw = createRedisClient(redisOptions);
    try {
      await store.append({ entry: entry({ id: "s1" }), kind: "birth", isTerminal: false });
      await store.append({
        entry: entry({ id: "s2", executionStatus: "FINISHED" }),
        kind: "transition",
        isTerminal: true,
      });
      // Simulate the completion TTL firing.
      await raw.del("snap:{run_1}:e", "snap:{run_1}:idx", "snap:{run_1}:cur", "snap:{run_1}:seq");
      const after = await store.append({
        entry: entry({ id: "s4" }),
        kind: "transition",
        isTerminal: false,
      });
      expect(after).toEqual({ outcome: "skippedNoKeyspace" });
      expect(await raw.exists("snap:{run_1}:e")).toBe(0);
    } finally {
      await raw.quit();
      await store.quit();
    }
  });
});

describe("getSince", () => {
  redisTest("misses on an unknown since id", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "s1" }), kind: "birth", isTerminal: false });
      expect(await store.getSince("run_1", "unknown")).toEqual({ kind: "miss" });
    } finally {
      await store.quit();
    }
  });

  redisTest("resolves an INVALID since id through its own seq field", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "s1" }), kind: "birth", isTerminal: false });
      await store.append({
        entry: entry({ id: "s_bad", error: "x" }),
        kind: "transition",
        isTerminal: false,
      });
      await store.append({ entry: entry({ id: "s3" }), kind: "transition", isTerminal: false });

      // s_bad is not in the valid-only index, so ZSCORE misses and the '#s' field answers instead.
      const r = await store.getSince("run_1", "s_bad");
      expect(r.kind).toBe("hit");
      if (r.kind !== "hit") throw new Error("unreachable");
      expect(r.entries.map((e) => e.id)).toEqual(["s3"]);
    } finally {
      await store.quit();
    }
  });

  redisTest("returns the NEWEST N ascending, not the oldest", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000, sinceLimit: 5 });
    try {
      await store.append({ entry: entry({ id: "s0" }), kind: "birth", isTerminal: false });
      for (let i = 1; i <= 12; i++) {
        await store.append({
          entry: entry({ id: `s${i}` }),
          kind: "transition",
          isTerminal: false,
        });
      }
      const r = await store.getSince("run_1", "s0");
      if (r.kind !== "hit") throw new Error("expected a hit");
      // The engine reads createdAt desc / take N / reverse, so the window is the newest N ascending.
      expect(r.entries.map((e) => e.id)).toEqual(["s8", "s9", "s10", "s11", "s12"]);
    } finally {
      await store.quit();
    }
  });

  redisTest("excludes invalid entries from the window", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "s0" }), kind: "birth", isTerminal: false });
      await store.append({
        entry: entry({ id: "s_bad", error: "x" }),
        kind: "transition",
        isTerminal: false,
      });
      await store.append({ entry: entry({ id: "s2" }), kind: "transition", isTerminal: false });
      const r = await store.getSince("run_1", "s0");
      if (r.kind !== "hit") throw new Error("expected a hit");
      expect(r.entries.map((e) => e.id)).toEqual(["s2"]);
    } finally {
      await store.quit();
    }
  });

  redisTest("resolves waitpoint ids for the HEAD only", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "s0" }), kind: "birth", isTerminal: false });
      await store.append({
        entry: entry({ id: "s1" }),
        kind: "transition",
        isTerminal: false,
        cycle: { kind: "new", completedWaitpoints: [{ id: "w_old", index: 0 }] },
      });
      await store.append({
        entry: entry({ id: "s2" }),
        kind: "transition",
        isTerminal: false,
        cycle: { kind: "new", completedWaitpoints: [{ id: "w_new", index: 0 }] },
      });
      const r = await store.getSince("run_1", "s0");
      if (r.kind !== "hit") throw new Error("expected a hit");
      // The head is the NEWEST entry, and only it carries resolved ids.
      expect(r.headWaitpointIds.order).toEqual(["w_new"]);
      expect(r.entries.at(-1)?.id).toBe("s2");
      expect(r.entries[0]?.completedWaitpointIds).toBeUndefined();
    } finally {
      await store.quit();
    }
  });

  redisTest("misses for a foreign environment", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "s0" }), kind: "birth", isTerminal: false });
      await store.append({ entry: entry({ id: "s1" }), kind: "transition", isTerminal: false });
      expect(await store.getSince("run_1", "s0", { environmentId: "env_other" })).toEqual({
        kind: "miss",
      });
    } finally {
      await store.quit();
    }
  });

  redisTest("misses for a foreign environment even at the newest id", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "s0" }), kind: "birth", isTerminal: false });
      await store.append({ entry: entry({ id: "s1" }), kind: "transition", isTerminal: false });
      // The window here is empty (s1 is the newest), so this is the case the old reply.length > 1
      // guard could never catch: an empty window must not silently coerce a foreign miss into a hit.
      expect(await store.getSince("run_1", "s1", { environmentId: "env_other" })).toEqual({
        kind: "miss",
      });
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "hits with zero entries when nothing follows the since id",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      try {
        await store.append({ entry: entry({ id: "s0" }), kind: "birth", isTerminal: false });
        // Resolves, nothing after it: "nothing new", NOT "not found".
        expect(await store.getSince("run_1", "s0")).toEqual({
          kind: "hit",
          entries: [],
          headWaitpointIds: { present: false, distinctIds: [], order: [] },
        });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "skips an entry whose body was evicted rather than throwing",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      const raw = createRedisClient(redisOptions);
      try {
        await store.append({ entry: entry({ id: "s0" }), kind: "birth", isTerminal: false });
        await store.append({ entry: entry({ id: "s1" }), kind: "transition", isTerminal: false });
        await store.append({ entry: entry({ id: "s2" }), kind: "transition", isTerminal: false });

        // The mirror of the case the append script documents: idx survives while the entry body in
        // `e` is gone. The seq field is left in place so the id still resolves.
        await raw.hdel("snap:{run_1}:e", "s1");

        const r = await store.getSince("run_1", "s0");
        expect(r.kind).toBe("hit");
        if (r.kind !== "hit") throw new Error("unreachable");
        expect(r.entries.map((e) => e.id)).toEqual(["s2"]);
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );

  redisTest(
    "hits with zero entries when scoped to the since entry's own environment",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      try {
        await store.append({ entry: entry({ id: "s0" }), kind: "birth", isTerminal: false });
        // Matching environment, nothing after it: pins that an empty window resolves via sinceRaw,
        // not by falling through to the "sinceRaw missing" miss path.
        expect(await store.getSince("run_1", "s0", { environmentId: "env_1" })).toEqual({
          kind: "hit",
          entries: [],
          headWaitpointIds: { present: false, distinctIds: [], order: [] },
        });
      } finally {
        await store.quit();
      }
    }
  );
});
