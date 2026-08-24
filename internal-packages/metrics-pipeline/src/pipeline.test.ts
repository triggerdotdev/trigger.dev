import { describe, expect, it } from "vitest";
import { createMetricsGaugeComputeLua } from "./lua.js";
import { dedupTokenFromEntryIds } from "./idempotency.js";
import { fnv1a32, shardFor } from "./hash.js";
import { allStreamKeys, entryOrderKey, entryTimeMs, streamKey } from "./types.js";

describe("shardFor", () => {
  it("is deterministic and in range", () => {
    expect(shardFor("queueA", 1)).toBe(0);
    const s = shardFor("queueA", 4);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(4);
    expect(shardFor("queueA", 4)).toBe(s);
    expect(fnv1a32("queueA")).toBe(fnv1a32("queueA"));
  });
});

describe("dedupTokenFromEntryIds", () => {
  it("is order-independent and set-sensitive", () => {
    expect(dedupTokenFromEntryIds(["1-0", "2-0"])).toBe(dedupTokenFromEntryIds(["2-0", "1-0"]));
    expect(dedupTokenFromEntryIds(["1-0"])).not.toBe(dedupTokenFromEntryIds(["2-0"]));
    expect(dedupTokenFromEntryIds(["1-0"])).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("stream keys", () => {
  it("names and parses entry time", () => {
    expect(streamKey({ name: "queue_metrics" }, 3)).toBe("queue_metrics:{3}");
    expect(allStreamKeys({ name: "qm", shardCount: 2, consumerGroup: "cg" })).toEqual([
      "qm:{0}",
      "qm:{1}",
    ]);
    expect(entryTimeMs("1717000000000-5")).toBe(1717000000000);
    expect(entryTimeMs("nope")).toBeNull();
  });

  it("entryOrderKey stays exact and strictly monotonic at real epoch magnitudes", () => {
    const ms = 1783000000000; // ~2026: ms*1e6 is past JS safe-integer range, so a number key
    const k = (seq: number) => BigInt(entryOrderKey(`${ms}-${seq}`));
    // adjacent seq within one ms must not collapse to the same key (the float bug)
    expect(k(0)).toBe(BigInt(ms) * 1000000n);
    expect(k(1) - k(0)).toBe(1n);
    expect(k(2) - k(1)).toBe(1n);
    // a later ms always outranks any seq of an earlier ms (up to the 1M/ms factor)
    expect(BigInt(entryOrderKey(`${ms + 1}-0`))).toBeGreaterThan(k(999999));
  });
});

describe("createMetricsGaugeComputeLua", () => {
  it("assigns __qm_g inside a gated, pcall-wrapped block and never XADDs", () => {
    const lua = createMetricsGaugeComputeLua({
      enabledArg: "ARGV[#ARGV] == '1'",
      queued: "redis.call('ZCARD', KEYS[2])",
      running: "queueCurrent",
      queueLimit: "queueLimit",
      envQueued: "redis.call('ZCARD', KEYS[8])",
      envRunning: "envCurrent",
      envLimit: "envLimit",
    });

    expect(lua).toContain("if ARGV[#ARGV] == '1' then");
    expect(lua).toContain("pcall(function()");
    expect(lua).toContain("__qm_g = {__ql, __cc, __lim, __eql, __ec, __elim, __thr}");
    expect(lua).toContain("if __cc >= __lim and __ql > 0 then __thr = 1 end");
    // The whole point of the refactor: no Redis write happens in the run-queue script.
    expect(lua).not.toContain("XADD");
  });

  it("honors a custom throttled expression and preamble", () => {
    const lua = createMetricsGaugeComputeLua({
      enabledArg: "true",
      preamble: "local agg = 1",
      queued: "0",
      running: "0",
      queueLimit: "0",
      envQueued: "0",
      envRunning: "0",
      envLimit: "0",
      throttledExpr: "false",
    });
    expect(lua).toContain("local agg = 1");
    expect(lua).toContain("if false then __thr = 1 end");
    expect(lua).not.toContain("XADD");
  });

  it("appends the CK-health tail only when both CK params are set", () => {
    const withCk = createMetricsGaugeComputeLua({
      enabledArg: "true",
      queued: "0",
      running: "0",
      queueLimit: "0",
      envQueued: "0",
      envRunning: "0",
      envLimit: "0",
      ckBacklogged: "redis.call('ZCARD', ckIndexKey)",
      ckMaxWaitMs: "__ckwait",
    });
    expect(withCk).toContain(
      "__qm_g = {__ql, __cc, __lim, __eql, __ec, __elim, __thr, __ckq, __ckw}"
    );
    expect(withCk).toContain("local __ckq = tonumber(redis.call('ZCARD', ckIndexKey)) or 0");

    const withoutCk = createMetricsGaugeComputeLua({
      enabledArg: "true",
      queued: "0",
      running: "0",
      queueLimit: "0",
      envQueued: "0",
      envRunning: "0",
      envLimit: "0",
      ckBacklogged: "0",
    });
    expect(withoutCk).toContain("__qm_g = {__ql, __cc, __lim, __eql, __ec, __elim, __thr}");
    expect(withoutCk).not.toContain("__ckq");
  });
});
