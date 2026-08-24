import { describe, expect, it } from "vitest";
import { resolveTransactionResilience } from "~/v3/transactionResilience.server";

describe("resolveTransactionResilience per-shard", () => {
  it("builds a distinct budget per call, so one shard's storm cannot drain another's", () => {
    const a = resolveTransactionResilience("run-ops-shard-a", {});
    const b = resolveTransactionResilience("run-ops-shard-b", {});
    expect(a.startRetry.budget).not.toBe(b.startRetry.budget);
  });

  it("accepts an arbitrary pool label and honours a maxWait override", () => {
    expect(() => resolveTransactionResilience("run-ops-shard-z", { maxWaitMs: 1234 })).not.toThrow();
    expect(resolveTransactionResilience("run-ops-shard-z", { maxWaitMs: 1234 }).maxWait).toBe(1234);
  });
});
