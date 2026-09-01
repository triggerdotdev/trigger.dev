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
    readPercent: 100,
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
