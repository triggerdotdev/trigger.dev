// The read cohort is pure arithmetic on the run id, so it needs no containers. Keeping it out of the
// container-backed suite also keeps that suite small enough to run reliably.
import { describe, expect, it } from "vitest";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreMode,
} from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";

type CohortProbe = { readsFromRedis(runId: string): boolean };

function probe(mode: SnapshotStoreMode, readPercent: number): CohortProbe {
  // lazyConnect keeps the client from dialling anything: no read in this suite reaches the store.
  const redis = new RedisSnapshotStore({
    redisOptions: { host: "127.0.0.1", port: 1, lazyConnect: true, retryStrategy: () => null },
    completedTtlMs: 1,
  });

  return new TaskRunExecutionSnapshotStore({} as RunStore, {
    store: redis,
    mode,
    readPercent,
  }) as unknown as CohortProbe;
}

const ids = Array.from({ length: 500 }, (_, n) => `run_cohort_${n}_${n * 7919}`);

describe("the read cohort", () => {
  it("reads nothing from Redis before the read positions", () => {
    for (const mode of ["off", "dual-write", "compare"] as const) {
      const store = probe(mode, 100);
      expect(ids.every((id) => !store.readsFromRedis(id))).toBe(true);
    }
  });

  it("reads everything from Redis at 100 percent", () => {
    for (const mode of ["redis-read", "redis-only"] as const) {
      const store = probe(mode, 100);
      expect(ids.every((id) => store.readsFromRedis(id))).toBe(true);
    }
  });

  it("reads nothing from Redis at 0 percent", () => {
    const store = probe("redis-read", 0);
    expect(ids.every((id) => !store.readsFromRedis(id))).toBe(true);
  });

  it("gives one run the same answer every time", () => {
    // A run that changed store between two reads of one poll could show the log going backwards.
    const store = probe("redis-read", 50);

    for (const id of ids.slice(0, 50)) {
      const first = store.readsFromRedis(id);
      for (let i = 0; i < 5; i++) {
        expect(store.readsFromRedis(id)).toBe(first);
      }
    }
  });

  it("gives two instances of the same dial the same answer", () => {
    // The cohort must not depend on process state, or a redeploy reshuffles every in-flight run.
    const first = probe("redis-read", 50);
    const second = probe("redis-read", 50);

    for (const id of ids.slice(0, 50)) {
      expect(second.readsFromRedis(id)).toBe(first.readsFromRedis(id));
    }
  });

  it("spreads a population across the dial", () => {
    const store = probe("redis-read", 50);
    const enabled = ids.filter((id) => store.readsFromRedis(id)).length;

    // A wide band: this asserts the hash spreads at all, not that it is uniform.
    expect(enabled).toBeGreaterThan(150);
    expect(enabled).toBeLessThan(350);
  });

  it("grows the cohort monotonically as the dial rises", () => {
    const at = (percent: number) => {
      const store = probe("redis-read", percent);
      return new Set(ids.filter((id) => store.readsFromRedis(id)));
    };

    const ten = at(10);
    const fifty = at(50);
    const ninety = at(90);

    // Raising the dial must only ever add runs. A run that fell out on the way up would flip back to
    // Postgres mid-flight, which is the thing the stable hash exists to prevent.
    expect([...ten].every((id) => fifty.has(id))).toBe(true);
    expect([...fifty].every((id) => ninety.has(id))).toBe(true);
  });
});
