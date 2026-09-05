// A failed birth append is fatal by the run's FIXED birth residency, which a birth fixes from the
// ORGANISATION dial (never the global position). Before redis-only Postgres is authoritative, so a
// lost birth is survivable and run creation proceeds; a redis-only birth writes no Postgres snapshot,
// so a run born without its Redis snapshot would have none anywhere and the append must throw before
// the run row exists so the caller retries clean.
//
// The load-bearing case is the second test: the global dial is redis-only while THIS org is still
// dual-write. The birth fixes the run's regime from the org's dial (dual-write => Postgres-backed),
// so the fatality follows the run, and a global redis-only does not wrongly fail run creation.
import { describe, expect, it } from "vitest";
import {
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreMode,
  type SnapshotStoreModeResolver,
} from "./taskRunExecutionSnapshotStore.js";
import type { RedisSnapshotStore } from "./redisSnapshotStore.js";
import type { RunRegime } from "./runRegimeCache.js";
import type { RunStore } from "./types.js";

const ORG = "org_a";

function harness(opts: { global: SnapshotStoreMode; forOrg: SnapshotStoreMode }) {
  const delegateCalls: string[] = [];
  const regime = new Map<string, RunRegime>();

  // Every append rejects with a NON-injected error, so the retry loop exhausts and hits the
  // terminal branch. An injected fault would mean "the process died", which is a different path. The
  // regime map is real, so the birth's residency decision is what the fatality gate reads.
  const redis = new Proxy({} as RedisSnapshotStore, {
    get: (_t, prop) => {
      if (prop === "regimeFor") return (runId: string) => regime.get(runId);
      if (prop === "recordRegime")
        return (runId: string, r: RunRegime) => {
          regime.set(runId, r);
        };
      if (prop === "append") {
        return () => Promise.reject(new Error("redis append boom"));
      }
      return () => Promise.resolve({ outcome: "written", seq: 1 });
    },
  });

  const delegate = new Proxy({} as Record<string, unknown>, {
    get:
      (_t, prop) =>
      (...__: unknown[]) => {
        delegateCalls.push(String(prop));
        return Promise.resolve({});
      },
  }) as unknown as RunStore;

  const modeResolver: SnapshotStoreModeResolver = {
    resolve: (organizationId?: string) =>
      organizationId === undefined ? opts.global : opts.forOrg,
  };

  const decorated = new TaskRunExecutionSnapshotStore(delegate, {
    store: redis,
    mode: opts.global,
    modeResolver,
  });
  return { decorated, delegateCalls };
}

function createRunParams() {
  return {
    data: { id: "run_1" },
    snapshot: {
      id: "snap_1",
      executionStatus: "RUN_CREATED" as const,
      description: "Run was created",
      runStatus: "PENDING" as const,
      environmentId: "env_1",
      environmentType: "PRODUCTION" as const,
      projectId: "proj_1",
      organizationId: ORG,
    },
  } as never;
}

describe("birth append fatality is decided by the organisation dial", () => {
  it("throws when the org resolves to redis-only, so run creation retries clean", async () => {
    // Global is dual-write; only the org is redis-only. The throw must follow the org, not global.
    const { decorated, delegateCalls } = harness({ global: "dual-write", forOrg: "redis-only" });

    await expect(decorated.createRun(createRunParams())).rejects.toThrow();
    // No run row when the birth is fatal.
    expect(delegateCalls).toEqual([]);
  });

  it("does NOT throw when the org is dual-write even though the global dial is redis-only", async () => {
    // The org-scoping guard: global redis-only would throw if the terminal branch read `this.mode`.
    const { decorated, delegateCalls } = harness({ global: "redis-only", forOrg: "dual-write" });

    await expect(decorated.createRun(createRunParams())).resolves.toBeDefined();
    expect(delegateCalls).toContain("createRun");
  });
});
