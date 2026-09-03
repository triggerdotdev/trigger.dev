// Reads are ORG-SCOPED: a single org soaked at redis-read must read from Redis while everyone else
// stays on Postgres, and the dual-write soak phase must pay zero new read cost — no org resolution
// fires until some org is actually read-enabled. Pure predicates plus proxy spies, no containers.
import { describe, expect, it } from "vitest";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type {
  SnapshotStoreMode,
  SnapshotStoreModeResolver,
} from "./taskRunExecutionSnapshotStore.js";
import type { RedisSnapshotStore } from "./redisSnapshotStore.js";
import type { RunStore } from "./types.js";

type CohortProbe = { readsFromRedis(runId: string, environmentId?: string): boolean };

function harness(opts: {
  globalMode: SnapshotStoreMode;
  readModeFor?: (runId: string, environmentId?: string) => SnapshotStoreMode;
  anyOrgReadEnabled?: () => boolean;
}) {
  const redisTouched: string[] = [];
  const redis = new Proxy({} as RedisSnapshotStore, {
    get: (_t, prop) => {
      return (...__: unknown[]) => {
        redisTouched.push(String(prop));
        // findSnapshotCompletedWaitpointIds calls getSnapshotWaitpointIds and returns on present.
        return Promise.resolve({ present: true, distinctIds: ["wp_1"], order: [] });
      };
    },
  });

  const delegateTouched: string[] = [];
  const delegate = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => {
      return (...__: unknown[]) => {
        delegateTouched.push(String(prop));
        return Promise.resolve([]);
      };
    },
  }) as unknown as RunStore;

  let readModeForCalls = 0;
  const modeResolver: SnapshotStoreModeResolver = {
    resolve: () => opts.globalMode,
    ...(opts.readModeFor && {
      readModeFor: (runId: string, environmentId?: string) => {
        readModeForCalls++;
        return opts.readModeFor!(runId, environmentId);
      },
    }),
    ...(opts.anyOrgReadEnabled && { anyOrgReadEnabled: opts.anyOrgReadEnabled }),
  };

  const decorated = new TaskRunExecutionSnapshotStore(delegate, {
    store: redis,
    mode: opts.globalMode,
    modeResolver,
  });

  return {
    decorated,
    probe: decorated as unknown as CohortProbe,
    redisTouched,
    delegateTouched,
    readModeForCalls: () => readModeForCalls,
  };
}

describe("org-scoped read routing", () => {
  it("serves an enabled org from Redis while the global dial is off", async () => {
    // org A at redis-read, global off, some org read-enabled. run_a resolves to org A.
    const h = harness({
      globalMode: "off",
      anyOrgReadEnabled: () => true,
      readModeFor: (runId) => (runId === "run_a" ? "redis-read" : "off"),
    });

    expect(h.probe.readsFromRedis("run_a")).toBe(true);
    // Complement to the short-circuit test's ==0: here the dial IS consulted per read.
    expect(h.readModeForCalls()).toBeGreaterThan(0);

    await h.decorated.findSnapshotCompletedWaitpointIds("snap_1", undefined, "run_a");
    expect(h.redisTouched).toContain("getSnapshotWaitpointIds");
  });

  it("keeps a non-enabled org on Postgres and never touches Redis", async () => {
    const h = harness({
      globalMode: "off",
      anyOrgReadEnabled: () => true,
      readModeFor: (runId) => (runId === "run_a" ? "redis-read" : "off"),
    });

    expect(h.probe.readsFromRedis("run_b")).toBe(false);

    await h.decorated.findSnapshotCompletedWaitpointIds("snap_1", undefined, "run_b");
    expect(h.redisTouched).toEqual([]);
    expect(h.delegateTouched).toContain("findSnapshotCompletedWaitpointIds");
  });

  it("short-circuits with no org resolution when no org is read-enabled and the global dial is off", async () => {
    const h = harness({
      globalMode: "off",
      anyOrgReadEnabled: () => false,
      readModeFor: () => "redis-read",
    });

    expect(h.probe.readsFromRedis("run_a")).toBe(false);
    // The whole point of the short-circuit: readModeFor is never consulted during the soak.
    expect(h.readModeForCalls()).toBe(0);

    await h.decorated.findSnapshotCompletedWaitpointIds("snap_1", undefined, "run_a");
    expect(h.redisTouched).toEqual([]);
    expect(h.delegateTouched).toContain("findSnapshotCompletedWaitpointIds");
  });

  it("threads the environmentId a read site holds into the resolver", () => {
    const seen: Array<string | undefined> = [];
    const h = harness({
      globalMode: "off",
      anyOrgReadEnabled: () => true,
      readModeFor: (_runId, environmentId) => {
        seen.push(environmentId);
        return "off";
      },
    });

    h.probe.readsFromRedis("run_a", "env_9");
    expect(seen).toContain("env_9");
  });
});

describe("resolver is transparent to routing when no per-org override applies", () => {
  const ids = Array.from({ length: 500 }, (_, n) => `run_cohort_${n}_${n * 7919}`);

  function plain(mode: SnapshotStoreMode): CohortProbe {
    return new TaskRunExecutionSnapshotStore({} as unknown as RunStore, {
      store: {} as never,
      mode,
    }) as unknown as CohortProbe;
  }

  it("routes every run exactly as the global dial did before per-org reads existed", () => {
    // A resolver that always answers the global mode, with no org read-enabled. The short-circuit
    // does not fire (global IS a read position) and effective === global, so the population must
    // route identically to a store with no resolver at all.
    const withResolver = harness({
      globalMode: "redis-read",
      anyOrgReadEnabled: () => false,
      readModeFor: () => "redis-read",
    }).probe;
    const withoutResolver = plain("redis-read");

    for (const id of ids) {
      expect(withResolver.readsFromRedis(id)).toBe(withoutResolver.readsFromRedis(id));
    }
  });
});
