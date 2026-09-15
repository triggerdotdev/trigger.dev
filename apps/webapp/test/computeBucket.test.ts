import { describe, it, expect } from "vitest";
import cuid from "cuid";
import { hashBucket } from "~/utils/computeBucket";

describe("hashBucket", () => {
  it("returns a stable value in [0, 100) for the same id", () => {
    const a = hashBucket("org_abc");
    const b = hashBucket("org_abc");
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(100);
  });

  it("is nested: the set enrolled at 1% is a subset of the set at 5%", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `org_${i}`);
    const at1 = new Set(ids.filter((id) => hashBucket(id) < 1));
    const at5 = ids.filter((id) => hashBucket(id) < 5);
    for (const id of at1) {
      expect(at5).toContain(id);
    }
  });

  it("distributes roughly uniformly", () => {
    const ids = Array.from({ length: 10000 }, (_, i) => `org_${i}`);
    const under10 = ids.filter((id) => hashBucket(id) < 10).length;
    expect(under10).toBeGreaterThan(700);
    expect(under10).toBeLessThan(1300);
  });

  // Org ids are `@default(cuid())` primary keys (e.g. "cjld2cjxh0000qzrmn831i7rn"),
  // not the synthetic sequential ids above. cuids share a "c" prefix + timestamp/counter
  // structure, so verify the hash still spreads *real-shaped* ids evenly across deciles
  // (so a percentage dial maps to ~that fraction of actual orgs, not just of the id space).
  it("distributes cuids evenly across all 10 deciles", () => {
    const ids = Array.from({ length: 20000 }, () => cuid());
    const counts = new Array(10).fill(0);
    for (const id of ids) {
      counts[Math.floor(hashBucket(id) / 10)]++;
    }
    // Expected ~2000 per decile; allow a wide band so it isn't flaky.
    for (const count of counts) {
      expect(count).toBeGreaterThan(1700);
      expect(count).toBeLessThan(2300);
    }
  });
});
