import { describe, it, expect } from "vitest";
import { hashBucket } from "./computeBucket";

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
});
