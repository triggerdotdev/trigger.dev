// Read routing is pure arithmetic on the mode, so it needs no containers. Keeping it out of the
// container-backed suite also keeps that suite small enough to run reliably.
import { describe, expect, it } from "vitest";
import { RedisSnapshotStore } from "./redisSnapshotStore.js";
import {
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreMode,
} from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";

type CohortProbe = { readsFromRedis(runId: string): boolean };

function probe(mode: SnapshotStoreMode): CohortProbe {
  // lazyConnect keeps the client from dialling anything: no read in this suite reaches the store.
  const redis = new RedisSnapshotStore({
    redisOptions: { host: "127.0.0.1", port: 1, lazyConnect: true, retryStrategy: () => null },
    completedTtlMs: 1,
  });

  return new TaskRunExecutionSnapshotStore({} as RunStore, {
    store: redis,
    mode,
  }) as unknown as CohortProbe;
}

const ids = Array.from({ length: 500 }, (_, n) => `run_cohort_${n}_${n * 7919}`);

describe("read routing", () => {
  it("reads nothing from Redis before the read positions", () => {
    for (const mode of ["off", "dual-write"] as const) {
      const store = probe(mode);
      expect(ids.every((id) => !store.readsFromRedis(id))).toBe(true);
    }
  });

  it("reads every run from Redis at a read position", () => {
    // `redis-read` is org-gated: an org at that position reads every one of its runs from Redis, and
    // `redis-only` always reads from Redis because Postgres holds no snapshot rows there.
    for (const mode of ["redis-read", "redis-only"] as const) {
      const store = probe(mode);
      expect(ids.every((id) => store.readsFromRedis(id))).toBe(true);
    }
  });
});
