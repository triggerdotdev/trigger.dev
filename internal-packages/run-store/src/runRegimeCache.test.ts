// The regime cache is the in-process record of each run's fixed birth residency. Its one invariant
// is monotonicity toward `redis-only`: that label suppresses Postgres and refuses a Postgres
// fallback, so a weaker `postgres` observation must never silently downgrade it.
import { describe, expect, it } from "vitest";
import { RunRegimeCache } from "./runRegimeCache.js";

describe("RunRegimeCache", () => {
  it("is unknown (undefined) for a run it has never seen", () => {
    const cache = new RunRegimeCache();
    expect(cache.get("run_1")).toBeUndefined();
  });

  it("records a redis-only birth and a postgres birth", () => {
    const cache = new RunRegimeCache();
    cache.recordRedisOnly("run_ro");
    cache.recordPostgres("run_pg");
    expect(cache.get("run_ro")).toBe("redis-only");
    expect(cache.get("run_pg")).toBe("postgres");
  });

  it("never downgrades redis-only to postgres (monotonic)", () => {
    const cache = new RunRegimeCache();
    cache.recordRedisOnly("run_1");
    cache.recordPostgres("run_1");
    expect(cache.get("run_1")).toBe("redis-only");
  });

  it("lets a definite redis-only observation upgrade a postgres label", () => {
    const cache = new RunRegimeCache();
    cache.recordPostgres("run_1");
    cache.recordRedisOnly("run_1");
    expect(cache.get("run_1")).toBe("redis-only");
  });

  it("record() dispatches by label, staying monotonic toward redis-only", () => {
    const cache = new RunRegimeCache();
    cache.record("run_1", "redis-only");
    cache.record("run_1", "postgres");
    expect(cache.get("run_1")).toBe("redis-only");

    cache.record("run_2", "postgres");
    expect(cache.get("run_2")).toBe("postgres");
  });

  it("is bounded: an old entry is evicted once the cap is exceeded", () => {
    const cache = new RunRegimeCache({ max: 2 });
    cache.recordRedisOnly("run_1");
    cache.recordRedisOnly("run_2");
    cache.recordRedisOnly("run_3");
    expect(cache.size).toBeLessThanOrEqual(2);
    // The first-inserted entry is the one evicted by the LRU.
    expect(cache.get("run_1")).toBeUndefined();
    expect(cache.get("run_3")).toBe("redis-only");
  });
});
