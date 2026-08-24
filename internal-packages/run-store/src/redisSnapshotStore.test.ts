// Unit suite for the raw Redis execution-snapshot store. Redis-only: the store holds no Prisma
// reference, so no Postgres container is needed.
import { expect, describe, vi } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";
import {
  snapshotKeys,
  deriveOrder,
  isValidFor,
  RedisSnapshotStore,
  type SnapshotEntryInput,
  type CompletedWaitpointsPointer,
  type CompletedWaitpointRecord,
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
    "round-trips a typed records array through the cycle hash's records field",
    async ({ redisOptions }) => {
      // The only place CompletedWaitpointRecord[] physically enters Redis. If the writer ever
      // serializes a different envelope, this is where that would show up as a broken round trip.
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      const raw = createRedisClient(redisOptions);
      const records: CompletedWaitpointRecord[] = [
        {
          id: "w_a",
          friendlyId: "waitpoint_a",
          type: "RUN",
          completedAt: "2026-01-01T00:00:00.000Z",
          outputType: "application/json",
          outputIsError: false,
          output: { deriveFromRun: true },
          completedByTaskRunId: "run_child",
        },
      ];
      try {
        await store.append({
          entry: entry({ id: "snap_1" }),
          kind: "birth",
          isTerminal: false,
          cycle: {
            kind: "new",
            completedWaitpoints: [{ id: "w_a", index: 0 }],
            records,
          },
        });

        const storedRaw = await raw.hget("snap:{run_1}:wp:1", "records");
        expect(JSON.parse(storedRaw!)).toEqual(records);
      } finally {
        raw.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a recordless new cycle clears another cycle's records off a reused key",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      const raw = createRedisClient(redisOptions);
      try {
        await store.append({
          entry: entry({ id: "snap_1" }),
          kind: "birth",
          isTerminal: false,
          cycle: {
            kind: "new",
            completedWaitpoints: [{ id: "w_a", index: 0 }],
            records: [
              {
                id: "w_a",
                friendlyId: "waitpoint_a",
                type: "MANUAL",
                completedAt: "2026-01-01T00:00:00.000Z",
                outputType: "application/json",
                outputIsError: false,
                output: { inline: "stale" },
              },
            ],
          },
        });
        expect(await raw.hget("snap:{run_1}:wp:1", "records")).not.toBeNull();

        // Only the counter is lost, as under maxmemory eviction. A birth does not check seq, so
        // the next new cycle re-mints cycleSeq 1 onto the surviving key.
        await raw.del("snap:{run_1}:seq");

        await store.append({
          entry: entry({ id: "snap_2" }),
          kind: "birth",
          isTerminal: false,
          cycle: { kind: "new", completedWaitpoints: [{ id: "w_b", index: 0 }] },
        });

        expect(await raw.hget("snap:{run_1}:wp:1", "order")).toBe(JSON.stringify(["w_b"]));
        expect(await raw.hget("snap:{run_1}:wp:1", "records")).toBeNull();
      } finally {
        raw.disconnect();
        await store.quit();
      }
    }
  );

  redisTest(
    "a carry-forward refuses a cycle this incarnation never minted",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions);
      try {
        await store.append({
          entry: entry({ id: "snap_1" }),
          kind: "birth",
          isTerminal: false,
          cycle: {
            kind: "new",
            completedWaitpoints: [{ id: "w_old", index: 0 }],
            records: [
              {
                id: "w_old",
                friendlyId: "waitpoint_old",
                type: "MANUAL",
                completedAt: "2026-01-01T00:00:00.000Z",
                outputType: "application/json",
                outputIsError: false,
                output: { inline: "stale" },
              },
            ],
          },
        });

        // Lose the whole keyspace except the cycle key, as under maxmemory eviction.
        await raw.del("snap:{run_1}:e", "snap:{run_1}:idx", "snap:{run_1}:cur", "snap:{run_1}:seq");

        const carried = await store.append({
          entry: entry({ id: "snap_2" }),
          kind: "birth",
          isTerminal: false,
          cycle: { kind: "carryForward", cycleSeq: 1 },
        });

        // Written, flagged, and carrying NO pointer: the dead incarnation's waitpoints must not
        // be served to a fresh run under a count that agrees with them.
        expect(carried).toMatchObject({ outcome: "written", cycleMismatch: true });
        expect(carried).not.toHaveProperty("cycleSeq");
        const read = await store.getLatest("run_1");
        expect(read?.cycle).toBeUndefined();
        expect(read?.completedWaitpointIds).toBeUndefined();
      } finally {
        raw.disconnect();
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
    const calls: string[] = [];
    const metrics = {
      recordAppend: () => {},
      recordEntryBytes: () => {},
      recordCycleKeyBytes: () => {},
      recordCycleCount: () => {},
      recordSkippedNoKeyspace: () => {},
      recordCycleMismatch: () => calls.push("mismatch"),
      recordLatency: () => {},
    };
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000, metrics });
    try {
      await store.append({ entry: entry({ id: "snap_1" }), kind: "birth", isTerminal: false });
      const r = await store.append({
        entry: entry({ id: "snap_2" }),
        kind: "transition",
        isTerminal: false,
        cycle: { kind: "carryForward", cycleSeq: 99 },
      });
      expect(r).toMatchObject({ outcome: "written", cycleMismatch: true });
      // recordCycleMismatch is required by the spec and was previously stubbed but never checked.
      expect(calls).toEqual(["mismatch"]);
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

describe("cycle key deletion sweep", () => {
  const KEY_SUFFIXES = ["e", "idx", "cur", "seq", "wp:1", "wp:2"] as const;
  const INJECTION_POINTS = ["beforeCarryForward", "beforeSecondNewCycle"] as const;

  function powerset<T>(items: readonly T[]): T[][] {
    let out: T[][] = [[]];
    for (const item of items) {
      out = out.concat(out.map((s) => [...s, item]));
    }
    return out;
  }

  // Mechanized replacement for the two hand-picked eviction regressions above: replays the same
  // birth/carryForward/new-cycle/terminal shape once per element of the powerset of key deletions,
  // at two points in the sequence, and checks that a cycle key's records never leak into a pointer
  // naming a different cycle than the one the key's own order field currently describes.
  redisTest(
    "records read back for a pointer never mention an id outside that pointer's own order",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      const raw = createRedisClient(redisOptions);
      type Violation = {
        subset: string[];
        injectionPoint: string;
        runId: string;
        pointer: CompletedWaitpointsPointer;
        recordsFound: unknown;
      };
      const violations: Violation[] = [];
      let replays = 0;

      try {
        for (const injectionPoint of INJECTION_POINTS) {
          for (const subset of powerset(KEY_SUFFIXES)) {
            replays++;
            const runId = `run_sweep_${injectionPoint}_${replays}`;
            const base = `snap:{${runId}}`;
            const damage = async () => {
              if (subset.length > 0) {
                await raw.del(...subset.map((s) => `${base}:${s}`));
              }
            };

            await store.append({
              entry: entry({ id: "snap_1", runId }),
              kind: "birth",
              isTerminal: false,
              cycle: {
                kind: "new",
                completedWaitpoints: [{ id: "w_c1", index: 0 }],
                records: [
                  {
                    id: "w_c1",
                    friendlyId: "waitpoint_c1",
                    type: "MANUAL",
                    completedAt: "2026-01-01T00:00:00.000Z",
                    outputType: "application/json",
                    outputIsError: false,
                    output: { inline: "payload_c1" },
                  },
                ],
              },
            });

            if (injectionPoint === "beforeCarryForward") await damage();
            await store.append({
              entry: entry({ id: "snap_2", runId }),
              kind: "transition",
              isTerminal: false,
              cycle: { kind: "carryForward", cycleSeq: 1 },
            });

            if (injectionPoint === "beforeSecondNewCycle") await damage();
            // birth, not transition: both eviction regressions above only reproduce past a birth's
            // liveness bypass -- a transition here would just report skippedNoKeyspace once e or seq
            // is gone, exempting the replay before the cycle-mint branch ever ran.
            await store.append({
              entry: entry({ id: "snap_3", runId }),
              kind: "birth",
              isTerminal: false,
              cycle: { kind: "new", completedWaitpoints: [{ id: "w_c2", index: 0 }] },
            });

            await store.append({
              entry: entry({ id: "snap_4", runId, executionStatus: "FINISHED" }),
              kind: "transition",
              isTerminal: true,
            });

            for (const id of ["snap_1", "snap_2", "snap_3", "snap_4"]) {
              const read = await store.getById(runId, id);
              if (!read?.cycle) continue;
              const orderIds = new Set(read.completedWaitpointIds?.order ?? []);
              const recordsRaw = await raw.hget(`${base}:wp:${read.cycle.cycleSeq}`, "records");
              if (recordsRaw === null) continue;
              const recordIds = (JSON.parse(recordsRaw) as { id: string }[]).map((r) => r.id);
              if (recordIds.some((rid) => !orderIds.has(rid))) {
                violations.push({
                  subset,
                  injectionPoint,
                  runId,
                  pointer: read.cycle,
                  recordsFound: recordIds,
                });
              }
            }
          }
        }
      } finally {
        raw.disconnect();
        await store.quit();
      }

      if (violations.length > 0) {
        throw new Error(
          `${violations.length} violation(s) across ${replays} replays. First: ` +
            JSON.stringify(violations[0])
        );
      }
    }
  );
});

describe("read-side cycle mismatch", () => {
  redisTest(
    "warns and records a metric when a cycle's count disagrees with its order",
    async ({ redisOptions }) => {
      const calls: string[] = [];
      const metrics = {
        recordAppend: () => {},
        recordEntryBytes: () => {},
        recordCycleKeyBytes: () => {},
        recordCycleCount: () => {},
        recordSkippedNoKeyspace: () => {},
        recordCycleMismatch: () => calls.push("mismatch"),
        recordLatency: () => {},
      };
      const logger = new Logger("test", "debug");
      const warnSpy = vi.spyOn(logger, "warn");
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000, metrics, logger });
      const raw = createRedisClient(redisOptions);
      try {
        await store.append({
          entry: entry({ id: "s1" }),
          kind: "birth",
          isTerminal: false,
          cycle: { kind: "new", completedWaitpoints: [{ id: "w_a", index: 0 }] },
        });
        await store.append({
          entry: entry({ id: "s2" }),
          kind: "transition",
          isTerminal: false,
          cycle: { kind: "carryForward", cycleSeq: 1 },
        });

        // The pointer's count field (written at append time) survives; only the cycle key's order
        // field is wiped, so a read must catch the disagreement instead of reporting count 1.
        await raw.hdel("snap:{run_1}:wp:1", "order");

        const read = await store.getById("run_1", "s2");
        expect(read?.cycle).toEqual({ cycleSeq: 1, count: 1 });
        expect(read?.completedWaitpointIds?.order).toEqual([]);
        expect(calls).toEqual(["mismatch"]);
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("cycle"),
          expect.objectContaining({ runId: "run_1" })
        );
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );
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
    "does not donate the evicted head's waitpoints to the surviving head",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      const raw = createRedisClient(redisOptions);
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

        // s2 is the newest and its body is gone. s1 must come back with ITS OWN waitpoints,
        // never s2's -- a dropped row must not donate its cycle data to the next one.
        await raw.hdel("snap:{run_1}:e", "s2");

        const r = await store.getSince("run_1", "s0");
        expect(r.kind).toBe("hit");
        if (r.kind !== "hit") throw new Error("unreachable");
        expect(r.entries.map((e) => e.id)).toEqual(["s1"]);
        expect(r.headWaitpointIds.order).toEqual(["w_old"]);
      } finally {
        await raw.quit();
        await store.quit();
      }
    }
  );

  redisTest(
    "does not donate a foreign-environment head's waitpoints to the query's window",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      try {
        await store.append({
          entry: entry({ id: "s1", environmentId: "env_a" }),
          kind: "birth",
          isTerminal: false,
          cycle: { kind: "new", completedWaitpoints: [{ id: "w_a", index: 0 }] },
        });
        // Same run, a different environment -- unreachable in production, but exercises the branch
        // where the Lua-chosen head is dropped by the TS-side environment filter.
        await store.append({
          entry: entry({ id: "s2", environmentId: "env_b" }),
          kind: "transition",
          isTerminal: false,
          cycle: { kind: "new", completedWaitpoints: [{ id: "w_b", index: 0 }] },
        });

        const r = await store.getSince("run_1", "s1", { environmentId: "env_a" });
        expect(r.kind).toBe("hit");
        if (r.kind !== "hit") throw new Error("unreachable");
        expect(r.entries).toEqual([]);
        expect(r.headWaitpointIds.order).toEqual([]);
      } finally {
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

describe("environment scoping", () => {
  redisTest("getLatest and getById return null for a foreign env", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "s1" }), kind: "birth", isTerminal: false });

      expect(await store.getLatest("run_1", { environmentId: "env_1" })).not.toBeNull();
      expect(await store.getLatest("run_1", { environmentId: "env_other" })).toBeNull();
      expect(await store.getById("run_1", "s1", { environmentId: "env_1" })).not.toBeNull();
      expect(await store.getById("run_1", "s1", { environmentId: "env_other" })).toBeNull();
    } finally {
      await store.quit();
    }
  });

  redisTest("getLatest returns null for a run with no keys", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      expect(await store.getLatest("run_absent")).toBeNull();
      expect(await store.getById("run_absent", "nope")).toBeNull();
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "getSince returns entries when scoped to a matching, non-empty environment",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      try {
        await store.append({ entry: entry({ id: "s0" }), kind: "birth", isTerminal: false });
        await store.append({ entry: entry({ id: "s1" }), kind: "transition", isTerminal: false });
        await store.append({ entry: entry({ id: "s2" }), kind: "transition", isTerminal: false });
        // Every existing matching-env getSince test used an EMPTY window, so the per-row compare
        // in #decode never ran in the passing direction. This is the first to exercise it with rows.
        const r = await store.getSince("run_1", "s0", { environmentId: "env_1" });
        if (r.kind !== "hit") throw new Error("expected a hit");
        expect(r.entries.map((e) => e.id)).toEqual(["s1", "s2"]);
      } finally {
        await store.quit();
      }
    }
  );
});

describe("expectedCur compare-and-set", () => {
  redisTest("absent by default: cur advances unconditionally", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "s1" }), kind: "birth", isTerminal: false });
      const r = await store.append({
        entry: entry({ id: "s2", previousSnapshotId: "stale" }),
        kind: "transition",
        isTerminal: false,
      });
      expect(r).toMatchObject({ outcome: "written" });
      expect((await store.getLatest("run_1"))?.id).toBe("s2");
    } finally {
      await store.quit();
    }
  });

  redisTest("supplied and matching: the append proceeds", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "s1" }), kind: "birth", isTerminal: false });
      const r = await store.append({
        entry: entry({ id: "s2" }),
        kind: "transition",
        isTerminal: false,
        expectedCur: "s1",
      });
      expect(r).toMatchObject({ outcome: "written", seq: 2 });
    } finally {
      await store.quit();
    }
  });

  redisTest("supplied and stale: writes NOTHING and reports the fork", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
    try {
      await store.append({ entry: entry({ id: "s1" }), kind: "birth", isTerminal: false });
      await store.append({ entry: entry({ id: "s2" }), kind: "transition", isTerminal: false });

      // A second concurrent transition that read cur = s1 before s2 landed.
      const r = await store.append({
        entry: entry({ id: "s3" }),
        kind: "transition",
        isTerminal: false,
        expectedCur: "s1",
      });
      expect(r).toEqual({ outcome: "forked", actualCur: "s2" });

      // Nothing was written: no entry, cur is still s2 (not overwritten by s3, and not cleared),
      // and the seq counter did not move.
      expect(await store.getById("run_1", "s3")).toBeNull();
      expect((await store.getLatest("run_1"))?.id).toBe("s2");
      const next = await store.append({
        entry: entry({ id: "s4" }),
        kind: "transition",
        isTerminal: false,
      });
      expect(next).toMatchObject({ seq: 3 });
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "supplied as empty string: still enforces a check against an unset cur",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      try {
        // The birth sets cur to "s1", so a caller claiming cur is UNSET (expectedCur: "") must
        // fork rather than have "" silently treated as "no compare-and-set requested".
        await store.append({ entry: entry({ id: "s1" }), kind: "birth", isTerminal: false });
        const r = await store.append({
          entry: entry({ id: "s2" }),
          kind: "transition",
          isTerminal: false,
          expectedCur: "",
        });
        expect(r).toEqual({ outcome: "forked", actualCur: "s1" });
        expect(await store.getById("run_1", "s2")).toBeNull();
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a duplicate id wins over a stale CAS: retrying your own successful write is not a fork",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      try {
        await store.append({ entry: entry({ id: "s1" }), kind: "birth", isTerminal: false });
        await store.append({
          entry: entry({ id: "s2" }),
          kind: "transition",
          isTerminal: false,
          expectedCur: "s1",
        });

        // Retry of the same append: cur has since moved to s2, so a naive CAS-first check would
        // see actual=s2 != expected=s1 and report a fork -- but s2 is THIS write, not a rival's.
        const retry = await store.append({
          entry: entry({ id: "s2" }),
          kind: "transition",
          isTerminal: false,
          expectedCur: "s1",
        });
        expect(retry).toEqual({ outcome: "duplicate", seq: 2 });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "supplied as empty string against a genuinely unset cur: the append proceeds",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 1000 });
      try {
        // The load-bearing succeeding direction: expectedCur: "" asserts "cur is unset", and on a
        // fresh keyspace that assertion is TRUE, so the append must proceed, not fork.
        const r = await store.append({
          entry: entry({ id: "s1" }),
          kind: "birth",
          isTerminal: false,
          expectedCur: "",
        });
        expect(r).toMatchObject({ outcome: "written", seq: 1 });
      } finally {
        await store.quit();
      }
    }
  );
});

// CRC16/XMODEM over a key's hash tag, per Redis's cluster hashing rule. CLUSTER KEYSLOT is
// unavailable on this standalone container ("cluster support disabled"), so the slot is computed
// here instead. Verified against the `cluster-key-slot` package's output for our key shapes.
function crc16(str: string): number {
  let crc = 0;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function hashSlot(key: string): number {
  const start = key.indexOf("{");
  const end = start === -1 ? -1 : key.indexOf("}", start + 1);
  const tag = start !== -1 && end !== -1 && end > start + 1 ? key.slice(start + 1, end) : key;
  return crc16(tag) % 16384;
}

describe("hash tag and keyPrefix", () => {
  it("every key for one run lands in one cluster slot", () => {
    // Keys come from snapshotKeys() plus the wp:<n> suffix the Lua prelude derives the same way,
    // with a keyPrefix prepended by hand as ioredis would. A dropped hash tag would split the slots.
    // Pin the helper itself before trusting it: the published XMODEM check value, and two known
    // slots (one matching cluster-key-slot, one a different run's tag as a negative control --
    // otherwise a constant-valued crc16 would satisfy slots.size === 1 for the wrong reason).
    expect(crc16("123456789")).toBe(0x31c3);
    expect(hashSlot("engine:snap:{run_1}:e")).toBe(8108);
    expect(hashSlot("engine:snap:{run_2}:e")).toBe(12239);

    const k = snapshotKeys("run_1");
    const base = k.e.slice(0, -2);
    const keys = [k.e, k.idx, k.cur, k.seq, `${base}:wp:1`, `${base}:wp:2`].map(
      (key) => `engine:${key}`
    );
    const slots = new Set(keys.map(hashSlot));
    expect(slots.size).toBe(1);
  });

  redisTest("the terminal append expires the PREFIXED cycle keys", async ({ redisOptions }) => {
    // This is the guard for the trap: ioredis prefixes only the KEYS array, so a cycle key minted
    // inside Lua would be UNPREFIXED while the client wrote a prefixed one. Deriving it from KEYS[1]
    // inherits both the prefix and the hash tag. If someone later mints it in Lua, this fails.
    const prefixed = { ...redisOptions, keyPrefix: "engine:" };
    const store = new RedisSnapshotStore({ redisOptions: prefixed, completedTtlMs: 60_000 });
    const raw = createRedisClient(redisOptions);
    try {
      await store.append({
        entry: entry({ id: "s1" }),
        kind: "birth",
        isTerminal: false,
        cycle: { kind: "new", completedWaitpoints: [{ id: "w_a", index: 0 }] },
      });
      expect(await raw.exists("engine:snap:{run_1}:wp:1")).toBe(1);
      expect(await raw.exists("snap:{run_1}:wp:1")).toBe(0);

      await store.append({
        entry: entry({ id: "s2", executionStatus: "FINISHED" }),
        kind: "transition",
        isTerminal: true,
      });
      const ttl = await raw.pttl("engine:snap:{run_1}:wp:1");
      expect(ttl).toBeGreaterThan(50_000);
      expect(ttl).toBeLessThanOrEqual(60_000);
    } finally {
      raw.disconnect();
      await store.quit();
    }
  });

  redisTest("reads work through a keyPrefix", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({
      redisOptions: { ...redisOptions, keyPrefix: "engine:" },
      completedTtlMs: 60_000,
    });
    try {
      await store.append({
        entry: entry({ id: "s1" }),
        kind: "birth",
        isTerminal: false,
        cycle: { kind: "new", completedWaitpoints: [{ id: "w_a", index: 0 }] },
      });
      expect((await store.getLatest("run_1"))?.id).toBe("s1");
      expect((await store.getSnapshotWaitpointIds("run_1", "s1")).order).toEqual(["w_a"]);
    } finally {
      await store.quit();
    }
  });
});

describe("observability", () => {
  redisTest("cycle-key bytes cover records, not just order", async ({ redisOptions }) => {
    // The plan puts a metric on the wp:<cycleSeq> KEY size. records dominates that key once
    // populated, so measuring order alone understates it by orders of magnitude.
    const calls: Array<[string, number]> = [];
    const metrics = {
      recordAppend: () => {},
      recordEntryBytes: () => {},
      recordCycleKeyBytes: (b: number) => calls.push(["cycleBytes", b]),
      recordCycleCount: () => {},
      recordSkippedNoKeyspace: () => {},
      recordCycleMismatch: () => {},
      recordLatency: () => {},
    };
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000, metrics });
    try {
      const records: CompletedWaitpointRecord[] = [
        {
          id: "w_a",
          friendlyId: "waitpoint_a",
          type: "MANUAL",
          completedAt: "2026-01-01T00:00:00.000Z",
          outputType: "application/json",
          outputIsError: false,
          output: { inline: "y".repeat(20_000) },
        },
      ];
      const orderJson = JSON.stringify(["w_a"]);
      const recordsJson = JSON.stringify(records);

      await store.append({
        entry: entry({ id: "snap_1" }),
        kind: "birth",
        isTerminal: false,
        cycle: { kind: "new", completedWaitpoints: [{ id: "w_a", index: 0 }], records },
      });

      expect(calls).toEqual([
        [
          "cycleBytes",
          Buffer.byteLength(orderJson, "utf8") + Buffer.byteLength(recordsJson, "utf8"),
        ],
      ]);
    } finally {
      await store.quit();
    }
  });

  redisTest("records sizes and outcomes without ever rejecting", async ({ redisOptions }) => {
    const calls: unknown[][] = [];
    const metrics = {
      recordAppend: (o: string, t: string) => calls.push(["append", o, t]),
      recordEntryBytes: (b: number) => calls.push(["entryBytes", b]),
      recordCycleKeyBytes: (b: number) => calls.push(["cycleBytes", b]),
      recordCycleCount: (c: number) => calls.push(["cycleCount", c]),
      recordSkippedNoKeyspace: () => calls.push(["skipped"]),
      recordCycleMismatch: () => calls.push(["mismatch"]),
      recordLatency: (op: string) => calls.push(["latency", op]),
    };
    const store = new RedisSnapshotStore({
      redisOptions,
      completedTtlMs: 60_000,
      metrics,
      highWater: { entryBytes: 1 },
    });
    try {
      // A huge inline value is observed, never rejected or truncated: Postgres had no cap either.
      const big = "x".repeat(20_000);
      const bigEntry = entry({ id: "s1", description: big });
      const rawBytes = Buffer.byteLength(JSON.stringify(bigEntry), "utf8");
      const orderBytes = Buffer.byteLength(JSON.stringify(["w_a"]), "utf8");

      const r = await store.append({
        entry: bigEntry,
        kind: "birth",
        isTerminal: false,
        cycle: { kind: "new", completedWaitpoints: [{ id: "w_a", index: 0 }] },
      });
      expect(r).toMatchObject({ outcome: "written" });
      expect((await store.getById("run_1", "s1"))?.entry.description).toBe(big);

      // Exact values, not just `b > 0`: a swapped recordEntryBytes/recordCycleKeyBytes wiring
      // would still pass a `b > 0` check but fails this, since the two sizes are wildly different.
      expect(calls).toEqual([
        ["entryBytes", rawBytes],
        ["cycleBytes", orderBytes],
        ["cycleCount", 1],
        ["append", "written", "none"],
        ["latency", "append"],
        ["latency", "getById"],
      ]);
      calls.length = 0;

      await store.append({
        entry: entry({ id: "s2", runId: "run_absent" }),
        kind: "transition",
        isTerminal: false,
      });

      // Partitioned from the first append's calls: proves recordSkippedNoKeyspace fires ONLY on
      // this skip, not (also, harmlessly) on the earlier successful append.
      expect(calls).toEqual([
        ["skipped"],
        ["append", "skippedNoKeyspace", "none"],
        ["latency", "append"],
      ]);
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "names the run in a high-water warning, and stays silent under a high threshold",
    async ({ redisOptions }) => {
      const loudLogger = new Logger("test", "debug");
      const loudWarn = vi.spyOn(loudLogger, "warn");
      const loud = new RedisSnapshotStore({
        redisOptions,
        completedTtlMs: 1000,
        logger: loudLogger,
        highWater: { entryBytes: 1, cycleKeyBytes: 1, cycleCount: 0 },
      });

      const quietLogger = new Logger("test", "debug");
      const quietWarn = vi.spyOn(quietLogger, "warn");
      const quiet = new RedisSnapshotStore({
        redisOptions,
        completedTtlMs: 1000,
        logger: quietLogger,
        highWater: { entryBytes: 1_000_000, cycleKeyBytes: 1_000_000, cycleCount: 1_000_000 },
      });

      try {
        await loud.append({
          entry: entry({ id: "s1", runId: "run_loud" }),
          kind: "birth",
          isTerminal: false,
          cycle: { kind: "new", completedWaitpoints: [{ id: "w_a", index: 0 }] },
        });
        expect(loudWarn).toHaveBeenCalledTimes(3);
        for (const [, payload] of loudWarn.mock.calls) {
          expect(payload).toMatchObject({ runId: "run_loud" });
        }

        // Same shape of append, high thresholds: proves the mark is respected, not just logged.
        await quiet.append({
          entry: entry({ id: "s1", runId: "run_quiet" }),
          kind: "birth",
          isTerminal: false,
          cycle: { kind: "new", completedWaitpoints: [{ id: "w_a", index: 0 }] },
        });
        expect(quietWarn).not.toHaveBeenCalled();
      } finally {
        await loud.quit();
        await quiet.quit();
      }
    }
  );
});

describe("the reserved completedWaitpoints field", () => {
  redisTest("append rejects an entry that sets it", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_reserved_throw";
      const pointer: CompletedWaitpointsPointer = { cycleSeq: 1, count: 0 };
      await expect(
        store.append({
          entry: { ...entry({ id: "snap_1", runId }), completedWaitpoints: pointer },
          kind: "birth",
          isTerminal: false,
        })
      ).rejects.toThrow(/reserved/i);
    } finally {
      await store.quit();
    }
  });

  redisTest("a stored entry never holds the key", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_reserved_absent";
      await store.append({
        entry: entry({ id: "snap_1", runId }),
        kind: "birth",
        isTerminal: false,
      });
      const read = await store.getLatest(runId);
      expect(read).not.toBeNull();
      expect(read!.raw).not.toContain("completedWaitpoints");
      expect(read!.entry).not.toHaveProperty("completedWaitpoints");
    } finally {
      await store.quit();
    }
  });
});
