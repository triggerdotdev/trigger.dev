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
