import { describe, expect, it } from "vitest";
import {
  FANOUT_PARTITION_COUNT,
  WaitpointKeyTagError,
  assertSingleSlot,
  edgeField,
  fanoutIndexKeys,
  fanoutPartition,
  idempotencyKey,
  runBlockKeys,
  waitpointIdFromEdgeField,
  waitpointKeys,
  watcherField,
} from "./keys.js";

describe("waitpointKeys", () => {
  it("puts the record, its watchers, its queue and its fanout entry under one hash tag", () => {
    const k = waitpointKeys("abc123w");
    expect(k.record).toBe("wp:v1:{abc123w}");
    expect(k.watchers).toBe("wp:v1:{abc123w}:w");
    expect(k.queue).toBe("wp:v1:{abc123w}:q");
    expect(k.fanout).toBe("wp:v1:{abc123w}:f");
    // Colocation is what lets completion and fanout creation be one atomic script.
    expect(() => assertSingleSlot("wpComplete", Object.values(k))).not.toThrow();
  });
});

describe("runBlockKeys", () => {
  it("puts the block state under the run's tag", () => {
    const k = runBlockKeys("run_abc");
    expect(k.state).toBe("wp:v1:run:{run_abc}:st");
    expect(() => assertSingleSlot("runAbsorbBlockers", Object.values(k))).not.toThrow();
  });
});

describe("fanoutPartition", () => {
  it("is deterministic", () => {
    expect(fanoutPartition("w_abc")).toBe(fanoutPartition("w_abc"));
  });

  it("stays inside the partition count for every id it is given", () => {
    for (let i = 0; i < 2_000; i++) {
      const partition = fanoutPartition(`waitpoint_${i}`);
      expect(Number.isInteger(partition)).toBe(true);
      expect(partition).toBeGreaterThanOrEqual(0);
      expect(partition).toBeLessThan(FANOUT_PARTITION_COUNT);
    }
  });

  it("handles the empty id without producing NaN", () => {
    expect(fanoutPartition("")).toBeGreaterThanOrEqual(0);
    expect(fanoutPartition("")).toBeLessThan(FANOUT_PARTITION_COUNT);
  });

  it("uses every partition over a realistic id population", () => {
    // A hash that collapsed onto a few partitions would serialise the sweep and defeat the
    // point of partitioning at all.
    const used = new Set(
      Array.from({ length: 5_000 }, (_, i) => fanoutPartition(`waitpoint_abc${i}defg`))
    );
    expect(used.size).toBe(FANOUT_PARTITION_COUNT);
  });
});

describe("fanoutIndexKeys", () => {
  it("shares one tag per partition, so an entry can move between indexes atomically", () => {
    const k = fanoutIndexKeys(3);
    expect(k.due).toBe("wp:v1:f{p3}:due");
    expect(k.quarantine).toBe("wp:v1:f{p3}:quar");
    expect(() => assertSingleSlot("wpFanoutIndex", [k.due, k.quarantine])).not.toThrow();
  });

  it("keeps different partitions on different tags", () => {
    expect(() =>
      assertSingleSlot("wpFanoutIndex", [fanoutIndexKeys(0).due, fanoutIndexKeys(1).due])
    ).toThrow(WaitpointKeyTagError);
  });
});

describe("runBlockKeys", () => {
  it("puts all three run keys under one hash tag", () => {
    const k = runBlockKeys("run_abc");
    expect(k.pend).toBe("wp:v1:run:{run_abc}:pend");
    expect(k.done).toBe("wp:v1:run:{run_abc}:done");
    expect(k.edge).toBe("wp:v1:run:{run_abc}:edge");
  });
});

describe("idempotencyKey", () => {
  it("tags by environment, so one environment's reservations share a slot", () => {
    expect(idempotencyKey("env_1", "my-key")).toBe("wp:v1:idem:{env_1}:my-key");
  });
});

describe("edgeField", () => {
  it("keys by waitpoint id and batch index, matching the Postgres unique key", () => {
    expect(edgeField("w_a", 3)).toBe("w_a#3");
  });

  it("collapses a null or absent batch index onto one field", () => {
    expect(edgeField("w_a")).toBe("w_a#");
    expect(edgeField("w_a", null)).toBe("w_a#");
  });

  it("distinguishes index 0 from an absent index", () => {
    expect(edgeField("w_a", 0)).not.toBe(edgeField("w_a"));
  });
});

describe("waitpointIdFromEdgeField", () => {
  it("round-trips back to the waitpoint id", () => {
    for (const index of [undefined, null, 0, 7]) {
      expect(waitpointIdFromEdgeField(edgeField("w_a", index))).toBe("w_a");
    }
  });

  it("returns undefined for a field with no separator", () => {
    expect(waitpointIdFromEdgeField("nope")).toBeUndefined();
  });

  it("splits on the last separator, tolerating a '#' inside the waitpoint id", () => {
    expect(waitpointIdFromEdgeField("a#b#3")).toBe("a#b");
  });
});

describe("watcherField", () => {
  it("keys by run id, batch index and block id, so one run can watch at several indexes", () => {
    expect(watcherField("run_a", "blk_1", 2)).toBe("run_a#2#blk_1");
    expect(watcherField("run_a", "blk_1")).toBe("run_a##blk_1");
    expect(watcherField("run_a", "blk_1", 0)).not.toBe(watcherField("run_a", "blk_1"));
  });

  // The reason the block is in the field at all: two registrations of the same run on the
  // same waitpoint, from different blocks, must not collide under HSETNX.
  it("separates two blocks of the same run on the same waitpoint", () => {
    expect(watcherField("run_a", "blk_1")).not.toBe(watcherField("run_a", "blk_2"));
  });
});

describe("assertSingleSlot", () => {
  it("accepts keys that share one tag", () => {
    const k = runBlockKeys("run_abc");
    expect(() => assertSingleSlot("runReadBlockState", [k.pend, k.done, k.edge])).not.toThrow();
  });

  it("accepts a single tagged key", () => {
    expect(() => assertSingleSlot("wpIdemReserve", [idempotencyKey("env_1", "k")])).not.toThrow();
  });

  it("accepts an empty key list", () => {
    expect(() => assertSingleSlot("noKeys", [])).not.toThrow();
  });

  it("rejects keys from two different tags", () => {
    const wp = waitpointKeys("w_a");
    const run = runBlockKeys("run_abc");
    expect(() => assertSingleSlot("bad", [wp.record, run.pend])).toThrow(WaitpointKeyTagError);
  });

  it("rejects an untagged key", () => {
    expect(() => assertSingleSlot("bad", ["wp:no-tag"])).toThrow(WaitpointKeyTagError);
  });

  it("rejects an empty tag", () => {
    expect(() => assertSingleSlot("bad", ["wp:{}"])).toThrow(WaitpointKeyTagError);
  });

  it("rejects an empty first pair, matching Redis rather than skipping to a later one", () => {
    // Redis stops at the first `{`/`}` pair. An empty one means no tag at all, so it hashes
    // the whole key. A regex would have found `a` here and wrongly claimed a shared slot.
    expect(() => assertSingleSlot("bad", ["wp:{}{a}", "wp:{}{a}"])).toThrow(WaitpointKeyTagError);
  });

  it("takes the first pair when several are present", () => {
    expect(() => assertSingleSlot("ok", ["wp:{a}{b}", "wp:{a}:w"])).not.toThrow();
    expect(() => assertSingleSlot("bad", ["wp:{a}{b}", "wp:{b}:w"])).toThrow(WaitpointKeyTagError);
  });

  it("does not degrade on a key made of many opening braces", () => {
    const started = performance.now();
    expect(() => assertSingleSlot("bad", ["{".repeat(50_000)])).toThrow(WaitpointKeyTagError);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("names the operation and the offending key in the error", () => {
    const wp = waitpointKeys("w_a");
    const run = runBlockKeys("run_abc");
    try {
      assertSingleSlot("myOperation", [wp.record, run.pend]);
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(WaitpointKeyTagError);
      expect((error as Error).message).toContain("myOperation");
      expect((error as Error).message).toContain(run.pend);
    }
  });
});
