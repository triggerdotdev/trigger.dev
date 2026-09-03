// At `redis-only` Postgres holds no snapshots, so a Redis ERROR must NOT fall back to an empty
// Postgres — it must throw (retryable) so the run is not stranded. The gate is org-aware: a run whose
// org resolves to `redis-only` throws; an unresolved org throws only when some org is `redis-only`
// (conservative over-throw); a run resolved to a non-`redis-only` mode always falls back, even when a
// DIFFERENT org is `redis-only`. Pure predicates plus proxy spies, no containers.
import { describe, expect, it } from "vitest";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type {
  SnapshotStoreMode,
  SnapshotStoreModeResolver,
} from "./taskRunExecutionSnapshotStore.js";
import type { RedisSnapshotStore } from "./redisSnapshotStore.js";
import type { RunStore } from "./types.js";

function harness(opts: {
  globalMode: SnapshotStoreMode;
  readModeFor?: (runId: string, environmentId?: string) => SnapshotStoreMode | undefined;
  anyOrgRedisOnly?: () => boolean;
  anyOrgReadEnabled?: () => boolean;
}) {
  // Every Redis call throws: this is the brownout the fallback gate exists for.
  const redis = new Proxy({} as RedisSnapshotStore, {
    get: () => () => {
      throw new Error("redis brownout");
    },
  });

  const delegateTouched: string[] = [];
  const delegate = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => {
      return (...__: unknown[]) => {
        delegateTouched.push(String(prop));
        return Promise.resolve({ id: "pg_fallback" });
      };
    },
  }) as unknown as RunStore;

  const modeResolver: SnapshotStoreModeResolver = {
    resolve: () => opts.globalMode,
    ...(opts.readModeFor && {
      readModeFor: opts.readModeFor as SnapshotStoreModeResolver["readModeFor"],
    }),
    ...(opts.anyOrgRedisOnly && { anyOrgRedisOnly: opts.anyOrgRedisOnly }),
    ...(opts.anyOrgReadEnabled && { anyOrgReadEnabled: opts.anyOrgReadEnabled }),
  };

  const decorated = new TaskRunExecutionSnapshotStore(delegate, {
    store: redis,
    mode: opts.globalMode,
    modeResolver,
  });

  return { decorated, delegateTouched };
}

describe("redis-only fallback gate is org-aware", () => {
  it("(a) throws for a run whose org resolves to redis-only, never serving Postgres", async () => {
    const h = harness({
      globalMode: "dual-write",
      anyOrgReadEnabled: () => true,
      readModeFor: (runId) => (runId === "run_a" ? "redis-only" : undefined),
    });

    await expect(
      h.decorated.findLatestExecutionSnapshot("run_a", undefined, "env_a")
    ).rejects.toThrow("redis brownout");
    expect(h.delegateTouched).not.toContain("findLatestExecutionSnapshot");
  });

  it("(b) throws for an unresolved org while some org is redis-only", async () => {
    const h = harness({
      globalMode: "redis-read",
      readModeFor: () => undefined,
      anyOrgRedisOnly: () => true,
    });

    await expect(
      h.decorated.findLatestExecutionSnapshot("run_x", undefined, "env_x")
    ).rejects.toThrow("redis brownout");
    expect(h.delegateTouched).not.toContain("findLatestExecutionSnapshot");
  });

  it("(c) falls back for an unresolved org when no org is redis-only", async () => {
    const h = harness({
      globalMode: "redis-read",
      readModeFor: () => undefined,
      anyOrgRedisOnly: () => false,
    });

    const result = await h.decorated.findLatestExecutionSnapshot("run_x", undefined, "env_x");
    expect(result).toEqual({ id: "pg_fallback" });
    expect(h.delegateTouched).toContain("findLatestExecutionSnapshot");
  });

  it("(d) falls back for a run resolved to redis-read even when another org is redis-only", async () => {
    const h = harness({
      globalMode: "redis-read",
      readModeFor: () => "redis-read",
      anyOrgRedisOnly: () => true,
    });

    const result = await h.decorated.findLatestExecutionSnapshot("run_x", undefined, "env_x");
    expect(result).toEqual({ id: "pg_fallback" });
    expect(h.delegateTouched).toContain("findLatestExecutionSnapshot");
  });

  it("(e) throws when the global dial is redis-only (unchanged)", async () => {
    const h = harness({ globalMode: "redis-only" });

    await expect(
      h.decorated.findLatestExecutionSnapshot("run_x", undefined, "env_x")
    ).rejects.toThrow("redis brownout");
    expect(h.delegateTouched).not.toContain("findLatestExecutionSnapshot");
  });

  it("threads runId into a runId-only read site (findSnapshotCompletedWaitpointIds)", async () => {
    const seen: string[] = [];
    const h = harness({
      globalMode: "redis-read",
      anyOrgRedisOnly: () => true,
      readModeFor: (runId) => {
        seen.push(runId);
        return runId === "run_a" ? "redis-only" : undefined;
      },
    });

    await expect(
      h.decorated.findSnapshotCompletedWaitpointIds("snap_1", undefined, "run_a")
    ).rejects.toThrow("redis brownout");
    expect(seen).toContain("run_a");
    expect(h.delegateTouched).not.toContain("findSnapshotCompletedWaitpointIds");
  });
});

// The other half of the gate: a Redis MISS (not an error). At redis-only Postgres holds nothing,
// so a miss must THROW rather than delegate into an empty Postgres. Below redis-only a miss still
// falls back, because Postgres legitimately holds the pre-cutover data.
function missHarness(opts: {
  globalMode: SnapshotStoreMode;
  readModeFor?: (runId: string, environmentId?: string) => SnapshotStoreMode | undefined;
  anyOrgRedisOnly?: () => boolean;
  anyOrgReadEnabled?: () => boolean;
}) {
  // Every Redis read reports a MISS: null for the single/by-id reads, a miss window, an absent
  // waitpoint set.
  const redis = new Proxy({} as RedisSnapshotStore, {
    get: (_t, prop) => {
      if (prop === "getSinceCreatedAt") return () => Promise.resolve({ kind: "miss" });
      if (prop === "getSnapshotWaitpointIds")
        return () => Promise.resolve({ present: false, distinctIds: [], order: [] });
      return () => Promise.resolve(null);
    },
  });

  const delegateTouched: string[] = [];
  const delegate = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => {
      return (...__: unknown[]) => {
        delegateTouched.push(String(prop));
        return Promise.resolve({ id: "pg_fallback" });
      };
    },
  }) as unknown as RunStore;

  const modeResolver: SnapshotStoreModeResolver = {
    resolve: () => opts.globalMode,
    ...(opts.readModeFor && {
      readModeFor: opts.readModeFor as SnapshotStoreModeResolver["readModeFor"],
    }),
    ...(opts.anyOrgRedisOnly && { anyOrgRedisOnly: opts.anyOrgRedisOnly }),
    ...(opts.anyOrgReadEnabled && { anyOrgReadEnabled: opts.anyOrgReadEnabled }),
  };

  const decorated = new TaskRunExecutionSnapshotStore(delegate, {
    store: redis,
    mode: opts.globalMode,
    modeResolver,
  });

  return { decorated, delegateTouched };
}

describe("redis-only throws on a miss instead of serving empty Postgres", () => {
  it("findLatestExecutionSnapshot throws at global redis-only, never delegating", async () => {
    const h = missHarness({ globalMode: "redis-only" });

    await expect(
      h.decorated.findLatestExecutionSnapshot("run_x", undefined, "env_x")
    ).rejects.toThrow(/redis-only/);
    expect(h.delegateTouched).not.toContain("findLatestExecutionSnapshot");
  });

  it("findLatestExecutionSnapshot falls back at redis-read (Postgres holds pre-cutover data)", async () => {
    const h = missHarness({ globalMode: "redis-read" });

    const result = await h.decorated.findLatestExecutionSnapshot("run_x", undefined, "env_x");
    expect(result).toEqual({ id: "pg_fallback" });
    expect(h.delegateTouched).toContain("findLatestExecutionSnapshot");
  });

  it("throws for a run whose org resolves to redis-only, falls back for a redis-read org", async () => {
    const h = missHarness({
      globalMode: "redis-read",
      anyOrgReadEnabled: () => true,
      readModeFor: (runId) => (runId === "run_ro" ? "redis-only" : "redis-read"),
    });

    await expect(
      h.decorated.findLatestExecutionSnapshot("run_ro", undefined, "env_a")
    ).rejects.toThrow(/redis-only/);
    expect(h.delegateTouched).not.toContain("findLatestExecutionSnapshot");

    const result = await h.decorated.findLatestExecutionSnapshot("run_rr", undefined, "env_b");
    expect(result).toEqual({ id: "pg_fallback" });
    expect(h.delegateTouched).toContain("findLatestExecutionSnapshot");
  });

  it("findManyExecutionSnapshots throws on a miss window at redis-only", async () => {
    const h = missHarness({ globalMode: "redis-only" });

    await expect(
      h.decorated.findManyExecutionSnapshots({
        where: { runId: "run_x", isValid: true, createdAt: { gt: new Date(0) } },
        include: { checkpoint: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      } as never)
    ).rejects.toThrow(/redis-only/);
    expect(h.delegateTouched).not.toContain("findManyExecutionSnapshots");
  });

  it("findSnapshotCompletedWaitpointIds throws on an absent set at redis-only", async () => {
    const h = missHarness({ globalMode: "redis-only" });

    await expect(
      h.decorated.findSnapshotCompletedWaitpointIds("snap_1", undefined, "run_x")
    ).rejects.toThrow(/redis-only/);
    expect(h.delegateTouched).not.toContain("findSnapshotCompletedWaitpointIds");
  });

  it("findExecutionSnapshot throws on a by-id miss at redis-only", async () => {
    const h = missHarness({ globalMode: "redis-only" });

    await expect(
      h.decorated.findExecutionSnapshot({
        where: { id: "snap_1", runId: "run_x" },
        select: { createdAt: true },
      } as never)
    ).rejects.toThrow(/redis-only/);
    expect(h.delegateTouched).not.toContain("findExecutionSnapshot");
  });
});

// The unified decision: when the run→org cache is COLD (readModeFor undefined) and some org is
// redis-only, the sync gate cannot tell whether THIS run is redis-only. It must resolve the run's
// org authoritatively rather than either strand a redis-only run (empty Postgres) or over-throw a
// pre-cutover run. This harness supplies that authoritative hook and a configurable Redis read.
function authHarness(opts: {
  globalMode: SnapshotStoreMode;
  read: "miss" | "dangling" | "error";
  readModeFor?: (runId: string, environmentId?: string) => SnapshotStoreMode | undefined;
  anyOrgRedisOnly?: () => boolean;
  anyOrgReadEnabled?: () => boolean;
  authoritative?: (runId: string) => Promise<SnapshotStoreMode | undefined>;
}) {
  const danglingRead = {
    id: "snap_head",
    seq: 1,
    isValid: true,
    entry: { id: "snap_head", createdAt: new Date().toISOString() },
    raw: "{}",
    danglingCycle: true,
  };
  const redisRead = () => {
    if (opts.read === "error") throw new Error("redis brownout");
    return Promise.resolve(opts.read === "dangling" ? danglingRead : null);
  };
  const redis = new Proxy({} as RedisSnapshotStore, {
    get: (_t, prop) => {
      if (prop === "getSinceCreatedAt")
        return () => (opts.read === "error" ? redisRead() : Promise.resolve({ kind: "miss" }));
      if (prop === "getSnapshotWaitpointIds")
        return () =>
          opts.read === "error"
            ? redisRead()
            : Promise.resolve({ present: false, distinctIds: [], order: [] });
      return () => redisRead();
    },
  });

  const delegateTouched: string[] = [];
  const delegate = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => {
      return (...__: unknown[]) => {
        delegateTouched.push(String(prop));
        return Promise.resolve({ id: "pg_fallback" });
      };
    },
  }) as unknown as RunStore;

  const authoritativeCalls: string[] = [];
  const modeResolver: SnapshotStoreModeResolver = {
    resolve: () => opts.globalMode,
    ...(opts.readModeFor && {
      readModeFor: opts.readModeFor as SnapshotStoreModeResolver["readModeFor"],
    }),
    ...(opts.anyOrgRedisOnly && { anyOrgRedisOnly: opts.anyOrgRedisOnly }),
    ...(opts.anyOrgReadEnabled && { anyOrgReadEnabled: opts.anyOrgReadEnabled }),
    ...(opts.authoritative && {
      readModeForAuthoritative: (async (runId: string) => {
        authoritativeCalls.push(runId);
        return opts.authoritative!(runId);
      }) as SnapshotStoreModeResolver["readModeForAuthoritative"],
    }),
  };

  const decorated = new TaskRunExecutionSnapshotStore(delegate, {
    store: redis,
    mode: opts.globalMode,
    modeResolver,
  });

  return { decorated, delegateTouched, authoritativeCalls };
}

describe("redis-only fallback resolves a cold run→org cache authoritatively", () => {
  it("routing branch: a cold-cache redis-only run at global dual-write THROWS, never empty PG", async () => {
    const h = authHarness({
      globalMode: "dual-write",
      read: "miss",
      readModeFor: () => undefined,
      anyOrgRedisOnly: () => true,
      authoritative: async () => "redis-only",
    });

    await expect(
      h.decorated.findLatestExecutionSnapshot("run_cold", undefined, "env_a")
    ).rejects.toThrow(/redis-only/);
    expect(h.delegateTouched).not.toContain("findLatestExecutionSnapshot");
    expect(h.authoritativeCalls).toContain("run_cold");
  });

  it("routing branch: a cold-cache dual-write run falls back (no over-throw)", async () => {
    const h = authHarness({
      globalMode: "dual-write",
      read: "miss",
      readModeFor: () => undefined,
      anyOrgRedisOnly: () => true,
      authoritative: async () => "dual-write",
    });

    const result = await h.decorated.findLatestExecutionSnapshot("run_cold", undefined, "env_a");
    expect(result).toEqual({ id: "pg_fallback" });
    expect(h.delegateTouched).toContain("findLatestExecutionSnapshot");
  });

  it("off/dual-write with no org redis-only falls back WITHOUT an authoritative read", async () => {
    const h = authHarness({
      globalMode: "dual-write",
      read: "miss",
      readModeFor: () => undefined,
      anyOrgRedisOnly: () => false,
      authoritative: async () => "redis-only",
    });

    const result = await h.decorated.findLatestExecutionSnapshot("run_x", undefined, "env_a");
    expect(result).toEqual({ id: "pg_fallback" });
    expect(h.authoritativeCalls).toEqual([]);
  });

  it("MISS at global redis-read with a cold-cache pre-cutover run FALLS BACK (coexistence)", async () => {
    const h = authHarness({
      globalMode: "redis-read",
      read: "miss",
      anyOrgReadEnabled: () => true,
      readModeFor: () => undefined,
      anyOrgRedisOnly: () => true,
      authoritative: async () => "redis-read",
    });

    const result = await h.decorated.findLatestExecutionSnapshot("run_pre", undefined, "env_a");
    expect(result).toEqual({ id: "pg_fallback" });
    expect(h.delegateTouched).toContain("findLatestExecutionSnapshot");
  });

  it("MISS at global redis-read with a cold-cache redis-only run THROWS", async () => {
    const h = authHarness({
      globalMode: "redis-read",
      read: "miss",
      anyOrgReadEnabled: () => true,
      readModeFor: () => undefined,
      anyOrgRedisOnly: () => true,
      authoritative: async () => "redis-only",
    });

    await expect(
      h.decorated.findLatestExecutionSnapshot("run_ro", undefined, "env_a")
    ).rejects.toThrow(/redis-only/);
    expect(h.delegateTouched).not.toContain("findLatestExecutionSnapshot");
  });

  it("fails closed (THROWS) when the authoritative read itself fails and some org is redis-only", async () => {
    const h = authHarness({
      globalMode: "redis-read",
      read: "miss",
      anyOrgReadEnabled: () => true,
      readModeFor: () => undefined,
      anyOrgRedisOnly: () => true,
      authoritative: async () => {
        throw new Error("run→org read timed out");
      },
    });

    await expect(
      h.decorated.findLatestExecutionSnapshot("run_cold", undefined, "env_a")
    ).rejects.toThrow(/redis-only/);
    expect(h.delegateTouched).not.toContain("findLatestExecutionSnapshot");
  });

  it("danglingCycle at global redis-only THROWS, never empty PG", async () => {
    const h = authHarness({ globalMode: "redis-only", read: "dangling" });

    await expect(
      h.decorated.findLatestExecutionSnapshot("run_x", undefined, "env_a")
    ).rejects.toThrow(/redis-only/);
    expect(h.delegateTouched).not.toContain("findLatestExecutionSnapshot");
  });

  it("danglingCycle below redis-only still falls back to Postgres", async () => {
    const h = authHarness({
      globalMode: "redis-read",
      read: "dangling",
      anyOrgReadEnabled: () => true,
    });

    const result = await h.decorated.findLatestExecutionSnapshot("run_x", undefined, "env_a");
    expect(result).toEqual({ id: "pg_fallback" });
    expect(h.delegateTouched).toContain("findLatestExecutionSnapshot");
  });
});
