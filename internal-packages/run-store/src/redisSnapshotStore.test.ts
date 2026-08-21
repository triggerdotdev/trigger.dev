// Unit suite for the raw Redis execution-snapshot store. Redis-only: the store holds no Prisma
// reference, so no Postgres container is needed.
import { expect, describe } from "vitest";
import { redisTest } from "@internal/testcontainers";
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
    } finally {
      await store.quit();
    }
  });
});
