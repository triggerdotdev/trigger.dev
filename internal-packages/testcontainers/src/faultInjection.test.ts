import { expect, it, describe } from "vitest";
import { createFaultInjector } from "./faultInjection";

type B = "afterPgBeforeRedis" | "midFlushRetry";
class TestFault extends Error {
  constructor(readonly boundary: B) {
    super(`injected at ${boundary}`);
    this.name = "TestFault";
  }
}
const make = () => createFaultInjector<B>({ error: (b) => new TestFault(b) });

describe("createFaultInjector", () => {
  it("does not throw when nothing is armed", () => {
    const f = make();
    expect(() => f.hook("afterPgBeforeRedis", { runId: "r1" })).not.toThrow();
    expect(f.fired("afterPgBeforeRedis")).toBe(0);
  });

  it("throws the injected error while armed, and counts each throw", () => {
    const f = make();
    f.arm("afterPgBeforeRedis");
    expect(() => f.hook("afterPgBeforeRedis")).toThrow(TestFault);
    expect(f.fired("afterPgBeforeRedis")).toBe(1);
  });

  it("times limits the number of throws", () => {
    const f = make();
    f.arm("midFlushRetry", { times: 2 });
    expect(() => f.hook("midFlushRetry")).toThrow();
    expect(() => f.hook("midFlushRetry")).toThrow();
    expect(() => f.hook("midFlushRetry")).not.toThrow();
    expect(f.fired("midFlushRetry")).toBe(2);
  });

  it("runId scopes throws to the matching run only", () => {
    const f = make();
    f.arm("afterPgBeforeRedis", { runId: "r1" });
    expect(() => f.hook("afterPgBeforeRedis", { runId: "r2" })).not.toThrow();
    expect(() => f.hook("afterPgBeforeRedis", { runId: "r1" })).toThrow();
    expect(f.fired("afterPgBeforeRedis")).toBe(1);
  });

  it("rejects a non-integer or negative times, but allows the default (Infinity)", () => {
    const f = make();
    expect(() => f.arm("midFlushRetry", { times: Number.NaN })).toThrow(RangeError);
    expect(() => f.arm("midFlushRetry", { times: 1.5 })).toThrow(RangeError);
    expect(() => f.arm("midFlushRetry", { times: -1 })).toThrow(RangeError);
    expect(() => f.arm("midFlushRetry")).not.toThrow(); // unlimited
  });

  it("disarm clears a boundary", () => {
    const f = make();
    f.arm("afterPgBeforeRedis");
    f.disarm("afterPgBeforeRedis");
    expect(() => f.hook("afterPgBeforeRedis")).not.toThrow();
  });
});
