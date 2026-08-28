// The keyspace is a run's residency record, and it lives in Redis, so the store had to ask Redis to
// learn a run was NOT its own. That put Redis on the hot path for every transition of every run,
// resident or not: 2 percent with a healthy Redis, 4 times with a slow one, and it never decayed,
// because a fleet with no resident runs still asked once per transition.
//
// The cache is sound because residency is monotonic. Only a birth creates a keyspace: the append
// script refuses `kind: "transition"` into a dead one, and the repair appends as a transition. So
// non-resident is permanent, and a cached negative can never suppress a resident run's append.
import { describe, expect, it } from "vitest";
import { ResidencyCache } from "./residencyCache.js";

describe("ResidencyCache", () => {
  it("has no opinion about a run it has never seen", () => {
    expect(new ResidencyCache().get("run_a")).toBeUndefined();
  });

  it("remembers a run that has no keyspace, which is the whole point", () => {
    const cache = new ResidencyCache();
    cache.setNonResident("run_a");
    expect(cache.get("run_a")).toBe("non-resident");
  });

  it("remembers a run that has one", () => {
    const cache = new ResidencyCache();
    cache.setResident("run_a");
    expect(cache.get("run_a")).toBe("resident");
  });

  it("never lets a negative be overwritten by a positive", () => {
    // Non-resident is permanent, so a positive arriving afterwards is stale information, not news.
    // Honouring it would start mirroring a run half way through its life, which is the one thing
    // the residency model forbids.
    const cache = new ResidencyCache();
    cache.setNonResident("run_a");
    cache.setResident("run_a");
    expect(cache.get("run_a")).toBe("non-resident");
  });

  it("lets a positive be replaced by a negative", () => {
    // The safe direction: a keyspace can go away under a completion expiry, a sweep, or an
    // eviction. Believing that costs nothing, because the append script refuses the write anyway.
    const cache = new ResidencyCache();
    cache.setResident("run_a");
    cache.setNonResident("run_a");
    expect(cache.get("run_a")).toBe("non-resident");
  });

  it("stays inside its bound", () => {
    const cache = new ResidencyCache({ max: 10 });
    for (let i = 0; i < 100; i++) {
      cache.setNonResident(`run_${i}`);
    }
    expect(cache.size).toBeLessThanOrEqual(10);
    // An evicted entry is a cache miss, never a wrong answer: the next transition probes Redis once
    // and re-learns it.
    expect(cache.get("run_0")).toBeUndefined();
    expect(cache.get("run_99")).toBe("non-resident");
  });
});
