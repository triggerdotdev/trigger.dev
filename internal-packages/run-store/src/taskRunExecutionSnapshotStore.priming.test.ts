// The read path must do NO extra resolution during pure dual-write, and the run→org mappings it needs
// must arrive for free: the decorator primes the run→org cache on every mirrored write and every Redis
// read hit. `readModeFor` is a pure in-memory lookup (the off-path populate is gone), and the only
// residency work the read path can do — the keyspace birth-mode probe — runs solely when some org is
// redis-only, so counting probe calls counts the read path's residency reads.
import { describe, expect, it } from "vitest";
import {
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreMode,
  type SnapshotStoreModeResolver,
} from "./taskRunExecutionSnapshotStore.js";
import type { RedisSnapshotStore, SnapshotRead } from "./redisSnapshotStore.js";
import type { RunRegime } from "./runRegimeCache.js";
import type { RunStore } from "./types.js";

const SCOPE = {
  environmentId: "env_1",
  environmentType: "PRODUCTION",
  projectId: "proj_1",
  organizationId: "org_a",
} as const;

function harness(opts: {
  globalMode: SnapshotStoreMode;
  anyOrgReadEnabled?: boolean;
  anyOrgRedisOnly?: boolean;
  /** What Redis returns from getLatest, when a read routes to it. */
  latest?: SnapshotRead | null;
}) {
  // The run→org cache the decorator primes into, plus a probe counter. `readModeFor` reads the cache
  // in memory; only the keyspace birth-mode probe touches Redis for residency, so counting it counts
  // the read path's residency reads.
  const runOrg = new Map<string, string>();
  const regime = new Map<string, RunRegime>();
  let probes = 0;

  const redis = new Proxy({} as RedisSnapshotStore, {
    get: (_t, prop) => {
      if (prop === "getLatest") return () => Promise.resolve(opts.latest ?? null);
      if (prop === "regimeFor") return (runId: string) => regime.get(runId);
      if (prop === "recordRegime")
        return (runId: string, r: RunRegime) => {
          regime.set(runId, r);
        };
      if (prop === "readBirthMode")
        return () => {
          probes++;
          return Promise.resolve(undefined);
        };
      return () => Promise.resolve({ outcome: "written", seq: 1 });
    },
  });

  const delegateTouched: string[] = [];
  const delegate = new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => {
      return (...__: unknown[]) => {
        delegateTouched.push(String(prop));
        return Promise.resolve({ id: "pg_row" });
      };
    },
  }) as unknown as RunStore;

  const modeResolver: SnapshotStoreModeResolver = {
    resolve: () => opts.globalMode,
    prime: (runId: string, organizationId: string) => {
      runOrg.set(runId, organizationId);
    },
    readModeFor: (runId: string) => {
      const org = runOrg.get(runId);
      return org ? opts.globalMode : undefined;
    },
    anyOrgReadEnabled: () => opts.anyOrgReadEnabled ?? false,
    anyOrgRedisOnly: () => opts.anyOrgRedisOnly ?? false,
  };

  const decorated = new TaskRunExecutionSnapshotStore(delegate, {
    store: redis,
    mode: opts.globalMode,
    modeResolver,
  });

  return { decorated, runOrg, delegateTouched, probes: () => probes };
}

function completionForOrg(organizationId: string) {
  return {
    completedAt: new Date(),
    outputType: "application/json",
    usageDurationMs: 1,
    costInCents: 0,
    snapshot: {
      id: "snap_1",
      executionStatus: "FINISHED" as const,
      description: "done",
      runStatus: "COMPLETED_SUCCESSFULLY" as const,
      attemptNumber: 1,
      ...SCOPE,
      organizationId,
    },
  };
}

function redisRead(organizationId: string): SnapshotRead {
  return {
    id: "snap_1",
    seq: 1,
    isValid: true,
    raw: "{}",
    entry: {
      id: "snap_1",
      runId: "run_1",
      organizationId,
      executionStatus: "EXECUTING",
      createdAt: new Date().toISOString(),
    },
  };
}

describe("priming the run→org cache off the hot path", () => {
  it("a mirrored transition primes the run→org mapping, with no run→org DB read", async () => {
    const h = harness({ globalMode: "dual-write" });

    await h.decorated.completeAttemptSuccess("run_1", completionForOrg("org_a"), {
      select: { id: true },
    });

    expect(h.runOrg.get("run_1")).toBe("org_a");
    expect(h.probes()).toBe(0);
    // After the write, the run's mode resolves from the primed cache: a pure hit, still no DB read.
    expect(h.decorated.modeForTest("org_a")).toBe("dual-write");
    expect(h.probes()).toBe(0);
  });

  it("a Redis read hit primes the run→org mapping", async () => {
    const h = harness({
      globalMode: "redis-read",
      anyOrgReadEnabled: true,
      latest: redisRead("org_a"),
    });

    const latest = await h.decorated.findLatestExecutionSnapshot("run_1");

    expect(latest).not.toBeNull();
    expect(h.runOrg.get("run_1")).toBe("org_a");
  });

  it("a pure dual-write read issues ZERO run→org DB calls", async () => {
    const h = harness({
      globalMode: "dual-write",
      anyOrgReadEnabled: false,
      anyOrgRedisOnly: false,
    });

    const latest = await h.decorated.findLatestExecutionSnapshot("run_cold", undefined, "env_1");

    // Fell back to Postgres, and the authoritative (DB) leg was never consulted.
    expect(latest).toEqual({ id: "pg_row" });
    expect(h.delegateTouched).toContain("findLatestExecutionSnapshot");
    expect(h.probes()).toBe(0);
  });
});
