// M1 residency resolver, built on the M3 prepared/finalized state. Real Redis (testcontainers), no
// mocks: state is seeded through the real prepare/finalize primitives, and the one failure case
// injects a plain throwing read function (not a mock Redis).
import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { createRedisClient } from "@internal/redis";
import {
  RedisSnapshotStore,
  type PreparedEntry,
  type PreparedPgUnit,
  type SnapshotEntryInput,
  type StateVersionRead,
} from "./redisSnapshotStore.js";
import { snapshotKeys } from "./snapshotKeys.js";
import {
  SnapshotResidencyResolver,
  type SnapshotResidencyReads,
} from "./snapshotResidencyResolver.js";

function entry(
  over: Partial<SnapshotEntryInput> & { id: string; runId: string }
): SnapshotEntryInput {
  return {
    engine: "V2",
    executionStatus: "EXECUTING",
    description: "d",
    runStatus: "EXECUTING",
    createdAt: "2026-08-21T00:00:00.000Z",
    environmentId: "env_1",
    environmentType: "PRODUCTION",
    projectId: "proj_1",
    organizationId: "org_1",
    ...over,
  };
}

function birthUnit(
  runId: string,
  residency: "mirrored" | "redis-primary",
  over: Partial<PreparedPgUnit> = {}
): PreparedPgUnit {
  const b: PreparedEntry = { entry: entry({ id: "b0", runId }), kind: "birth", isTerminal: false };
  return {
    protocolVersion: 1,
    transitionToken: "birth",
    postgresXid: "1",
    runId,
    organizationId: "org_1",
    residency,
    logicalRunStoreRoute: "logical:1",
    entries: [b],
    ...over,
  };
}

// A finalized birth: prepare then finalize, so the run-state keyspace and residency marker exist,
// exactly as a real committed birth does.
async function committedBirth(
  store: RedisSnapshotStore,
  runId: string,
  residency: "mirrored" | "redis-primary"
): Promise<void> {
  await store.prepare(birthUnit(runId, residency));
  await store.finalize(runId, "birth");
}

// A read interface that delegates to the real store and counts each read, so a test can prove a
// second resolve is served from cache (no durable reads) or re-resolves (reads happen again).
class CountingReads implements SnapshotResidencyReads {
  stateVersion = 0;
  birthResidency = 0;
  preparedUnit = 0;
  constructor(private readonly inner: SnapshotResidencyReads) {}
  readStateVersion(runId: string): Promise<StateVersionRead> {
    this.stateVersion++;
    return this.inner.readStateVersion(runId);
  }
  readBirthResidency(runId: string): Promise<string | undefined> {
    this.birthResidency++;
    return this.inner.readBirthResidency(runId);
  }
  readPendingState(runId: string): Promise<{ prepared: boolean; quarantined: boolean }> {
    this.preparedUnit++;
    return this.inner.readPendingState(runId);
  }
  get total(): number {
    return this.stateVersion + this.birthResidency + this.preparedUnit;
  }
}

const alwaysExists = async () => true;
const neverExists = async () => false;

describe("SnapshotResidencyResolver durable resolution", () => {
  redisTest("a finalized mirrored birth resolves committed mirrored", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_res_mirrored";
      await committedBirth(store, runId, "mirrored");
      const resolver = new SnapshotResidencyResolver({ store, taskRunExists: alwaysExists });
      expect(await resolver.resolve(runId)).toEqual({ kind: "committed", residency: "mirrored" });
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "a finalized redis-primary birth resolves committed redis-primary",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_res_redisprimary";
        await committedBirth(store, runId, "redis-primary");
        const resolver = new SnapshotResidencyResolver({ store, taskRunExists: alwaysExists });
        expect(await resolver.resolve(runId)).toEqual({
          kind: "committed",
          residency: "redis-primary",
        });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("a prepared-but-unfinalized birth resolves pendingBirth", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_res_pending";
      await store.prepare(birthUnit(runId, "redis-primary"));
      const resolver = new SnapshotResidencyResolver({ store, taskRunExists: alwaysExists });
      expect(await resolver.resolve(runId)).toEqual({ kind: "pendingBirth" });
    } finally {
      await store.quit();
    }
  });

  redisTest("a run with no MemoryDB state resolves absent", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const resolver = new SnapshotResidencyResolver({ store, taskRunExists: alwaysExists });
      expect(await resolver.resolve("run_res_absent")).toEqual({ kind: "absent" });
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "a redis-primary run whose state expired (marker remaining) resolves expired",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_res_expired";
        await committedBirth(store, runId, "redis-primary");
        // Drop the run-state keys, leaving the no-TTL residency marker: the aged-out redis-primary run.
        await store.dropRun(runId);
        const resolver = new SnapshotResidencyResolver({ store, taskRunExists: alwaysExists });
        expect(await resolver.resolve(runId)).toEqual({ kind: "expired" });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "a mirrored run whose state expired resolves absent (reads Postgres)",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_res_mirror_expired";
        await committedBirth(store, runId, "mirrored");
        await store.dropRun(runId);
        const resolver = new SnapshotResidencyResolver({ store, taskRunExists: alwaysExists });
        expect(await resolver.resolve(runId)).toEqual({ kind: "absent" });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("a MemoryDB read failure resolves error, fail closed", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const failing: SnapshotResidencyReads = {
        readStateVersion: async () => {
          throw new Error("memorydb down");
        },
        readBirthResidency: (runId) => store.readBirthResidency(runId),
        readPendingState: (runId) => store.readPendingState(runId),
      };
      const resolver = new SnapshotResidencyResolver({
        store: failing,
        taskRunExists: alwaysExists,
      });
      expect(await resolver.resolve("run_res_error")).toEqual({ kind: "error" });
    } finally {
      await store.quit();
    }
  });

  redisTest("an unknown state version fails closed to error", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    const raw = createRedisClient(redisOptions);
    try {
      const runId = "run_res_badversion";
      await committedBirth(store, runId, "redis-primary");
      // Corrupt the stored state version: a value this build does not understand fails closed.
      await raw.hset(snapshotKeys(runId).seq, "sv", "999");
      const resolver = new SnapshotResidencyResolver({ store, taskRunExists: alwaysExists });
      expect(await resolver.resolve(runId)).toEqual({ kind: "error" });
    } finally {
      await raw.quit();
      await store.quit();
    }
  });
});

describe("SnapshotResidencyResolver caching", () => {
  redisTest("committed is served from cache on a second call", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_cache_committed";
      await committedBirth(store, runId, "mirrored");
      const counting = new CountingReads(store);
      const resolver = new SnapshotResidencyResolver({
        store: counting,
        taskRunExists: alwaysExists,
      });
      await resolver.resolve(runId);
      const afterFirst = counting.total;
      expect(afterFirst).toBeGreaterThan(0);
      await resolver.resolve(runId);
      expect(counting.total).toBe(afterFirst); // no additional durable reads
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "absent is cached only after taskRunExists is true and a re-check is still absent",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_cache_absent_true";
        const counting = new CountingReads(store);
        const resolver = new SnapshotResidencyResolver({
          store: counting,
          taskRunExists: alwaysExists,
        });
        expect(await resolver.resolve(runId)).toEqual({ kind: "absent" });
        const afterFirst = counting.total;
        // Second call served from cache: no more reads.
        expect(await resolver.resolve(runId)).toEqual({ kind: "absent" });
        expect(counting.total).toBe(afterFirst);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("absent is NOT cached when taskRunExists is false", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_cache_absent_false";
      const counting = new CountingReads(store);
      const resolver = new SnapshotResidencyResolver({
        store: counting,
        taskRunExists: neverExists,
      });
      expect(await resolver.resolve(runId)).toEqual({ kind: "absent" });
      const afterFirst = counting.total;
      // Not cached: the second call re-resolves from durable state.
      expect(await resolver.resolve(runId)).toEqual({ kind: "absent" });
      expect(counting.total).toBeGreaterThan(afterFirst);
    } finally {
      await store.quit();
    }
  });

  redisTest("pendingBirth is never cached", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const runId = "run_cache_pending";
      await store.prepare(birthUnit(runId, "redis-primary"));
      const counting = new CountingReads(store);
      const resolver = new SnapshotResidencyResolver({
        store: counting,
        taskRunExists: alwaysExists,
      });
      expect(await resolver.resolve(runId)).toEqual({ kind: "pendingBirth" });
      const afterFirst = counting.total;
      expect(await resolver.resolve(runId)).toEqual({ kind: "pendingBirth" });
      expect(counting.total).toBeGreaterThan(afterFirst);
    } finally {
      await store.quit();
    }
  });

  redisTest("error is never cached", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      let calls = 0;
      const failing: SnapshotResidencyReads = {
        readStateVersion: async () => {
          calls++;
          throw new Error("memorydb down");
        },
        readBirthResidency: (runId) => store.readBirthResidency(runId),
        readPendingState: (runId) => store.readPendingState(runId),
      };
      const resolver = new SnapshotResidencyResolver({
        store: failing,
        taskRunExists: alwaysExists,
      });
      expect(await resolver.resolve("run_cache_error")).toEqual({ kind: "error" });
      expect(await resolver.resolve("run_cache_error")).toEqual({ kind: "error" });
      expect(calls).toBe(2); // re-resolved, not cached
    } finally {
      await store.quit();
    }
  });

  redisTest(
    "a pending birth that finalizes resolves committed on retry",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_cache_pending_then_commit";
        await store.prepare(birthUnit(runId, "mirrored"));
        const resolver = new SnapshotResidencyResolver({ store, taskRunExists: alwaysExists });
        expect(await resolver.resolve(runId)).toEqual({ kind: "pendingBirth" });
        await store.finalize(runId, "birth");
        // pendingBirth was not cached, so the retry sees the finalized birth.
        expect(await resolver.resolve(runId)).toEqual({ kind: "committed", residency: "mirrored" });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "knownToExist skips the per-run existence probe (the batch already proved the run exists)",
    async ({ redisOptions }) => {
      // A route-less TTL batch resolves residency for runs it has ALREADY selected + locked, so the
      // TaskRun row is known to exist. The resolver must NOT repeat the per-run Postgres existence query
      // for those. We inject a counting existence fn (a fault injector over the real store: if the query
      // runs, the counter moves) and assert a knownToExist resolve of an absent run never touches it,
      // while an ordinary resolve does. Reverting the knownToExist guard turns the first assertion RED.
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        let probeCalls = 0;
        const countingExists = async () => {
          probeCalls++;
          return true;
        };
        const resolver = new SnapshotResidencyResolver({ store, taskRunExists: countingExists });

        // Absent run resolved as "known to exist": still absent (postgres-resident), but no existence probe.
        expect(await resolver.resolve("run_known_exists", { knownToExist: true })).toEqual({
          kind: "absent",
        });
        expect(probeCalls).toBe(0);

        // A DIFFERENT absent run resolved the ordinary way DOES run the probe — proving the seam is the
        // only reason the probe was skipped above, not that the probe is dead.
        expect(await resolver.resolve("run_ordinary_absent")).toEqual({ kind: "absent" });
        expect(probeCalls).toBe(1);
      } finally {
        await store.quit();
      }
    }
  );

  redisTest("LRU eviction forces a durable re-resolution", async ({ redisOptions }) => {
    const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
    try {
      const a = "run_lru_a";
      const b = "run_lru_b";
      await committedBirth(store, a, "mirrored");
      await committedBirth(store, b, "redis-primary");
      const counting = new CountingReads(store);
      const resolver = new SnapshotResidencyResolver({
        store: counting,
        taskRunExists: alwaysExists,
        max: 1,
      });
      await resolver.resolve(a); // caches a
      await resolver.resolve(b); // caches b, evicts a
      const afterTwo = counting.total;
      // a was evicted, so resolving it again reads durable state instead of the cache.
      expect(await resolver.resolve(a)).toEqual({ kind: "committed", residency: "mirrored" });
      expect(counting.total).toBeGreaterThan(afterTwo);
    } finally {
      await store.quit();
    }
  });
});
