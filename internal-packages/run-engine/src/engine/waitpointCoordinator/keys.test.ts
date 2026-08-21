import { describe, expect, it } from "vitest";
import {
  WaitpointKeyTagError,
  assertSingleSlot,
  edgeField,
  idempotencyKey,
  runBlockKeys,
  waitpointIdFromEdgeField,
  waitpointKeys,
  watcherField,
} from "./keys.js";

describe("waitpointKeys", () => {
  it("puts the record and its watchers under one hash tag", () => {
    const k = waitpointKeys("abc123w");
    expect(k.record).toBe("wp:{abc123w}");
    expect(k.watchers).toBe("wp:{abc123w}:w");
  });
});

describe("runBlockKeys", () => {
  it("puts all three run keys under one hash tag", () => {
    const k = runBlockKeys("run_abc");
    expect(k.pend).toBe("wp:run:{run_abc}:pend");
    expect(k.done).toBe("wp:run:{run_abc}:done");
    expect(k.edge).toBe("wp:run:{run_abc}:edge");
  });
});

describe("idempotencyKey", () => {
  it("tags by environment, so one environment's reservations share a slot", () => {
    expect(idempotencyKey("env_1", "my-key")).toBe("wp:idem:{env_1}:my-key");
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

  it("round-trips back to the waitpoint id", () => {
    for (const index of [undefined, null, 0, 7]) {
      expect(waitpointIdFromEdgeField(edgeField("w_a", index))).toBe("w_a");
    }
  });

  it("returns undefined for a field with no separator", () => {
    expect(waitpointIdFromEdgeField("nope")).toBeUndefined();
  });
});

describe("watcherField", () => {
  it("keys by run id and batch index, so one run can watch at several indexes", () => {
    expect(watcherField("run_a", 2)).toBe("run_a#2");
    expect(watcherField("run_a")).toBe("run_a#");
    expect(watcherField("run_a", 0)).not.toBe(watcherField("run_a"));
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
