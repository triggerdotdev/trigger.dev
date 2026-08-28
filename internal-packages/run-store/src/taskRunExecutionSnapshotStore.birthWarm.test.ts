// The per-organisation dial is served from a short-lived cache, and on a miss the resolver answers
// with the DEPLOYMENT-WIDE position and warms the cache off the request path. For reads that is the
// right trade. For a BIRTH it is not: residency is fixed at birth and permanent, so a run born
// during a cache miss is excluded from the mirror for its whole life.
//
// Observed live: three runs born back to back were all resident, then after a 14 minute idle gap the
// next run was not, because the cache entry had expired. A cache miss is not a rare event, it is any
// gap longer than the cache lifetime, so on bursty traffic the first run of every burst was lost.
//
// So a birth waits for the organisation's real answer. Transitions do NOT: they stay dial-blind and
// synchronous, which is what stops a run changing stores half way through its life.
import { describe, expect, it } from "vitest";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type {
  SnapshotStoreMode,
  SnapshotStoreModeResolver,
} from "./taskRunExecutionSnapshotStore.js";
import type { RedisSnapshotStore } from "./redisSnapshotStore.js";
import type { RunStore } from "./types.js";

const SCOPE = {
  environmentId: "env_1",
  environmentType: "PRODUCTION",
  projectId: "proj_1",
  organizationId: "org_1",
} as const;

function harness(opts: {
  /** What resolve() answers BEFORE warm() has run. Models the cache-miss fallback. */
  cold: SnapshotStoreMode;
  /** What resolve() answers AFTER warm() has run. Models the organisation's real value. */
  warmed: SnapshotStoreMode;
  /** Omit to model a resolver that offers no warm at all. */
  offerWarm?: boolean;
  /** Make warm() reject, to prove a birth still proceeds. */
  warmThrows?: boolean;
}) {
  const appends: { kind: string }[] = [];
  let warmCalls = 0;
  let isWarm = false;

  const redis = {
    append: async (args: { kind: string }) => {
      appends.push({ kind: args.kind });
      return { outcome: "written" as const, seq: appends.length };
    },
  } as unknown as RedisSnapshotStore;

  const delegate = new Proxy({} as Record<string, unknown>, {
    get: () => () => Promise.resolve({}),
  }) as unknown as RunStore;

  const modeResolver: SnapshotStoreModeResolver = {
    resolve: () => (isWarm ? opts.warmed : opts.cold),
    ...(opts.offerWarm !== false && {
      warm: async () => {
        warmCalls += 1;
        if (opts.warmThrows) throw new Error("flag read failed");
        isWarm = true;
      },
    }),
  };

  const decorated = new TaskRunExecutionSnapshotStore(delegate, {
    store: redis,
    mode: opts.cold,
    modeResolver,
  });

  return { decorated, appends, warmCalls: () => warmCalls };
}

function birthParams() {
  return {
    data: { id: "run_1" } as never,
    snapshot: {
      engine: "V2" as const,
      executionStatus: "RUN_CREATED" as const,
      description: "Run created",
      runStatus: "PENDING" as const,
      ...SCOPE,
    },
  };
}

describe("a birth waits for the organisation's real dial", () => {
  it("mirrors when the cache was cold but the organisation is opted in", async () => {
    // The case that was losing runs: cold cache answers with the global `off`, the organisation is
    // actually at dual-write. Without warming, this birth is non-resident forever.
    const h = harness({ cold: "off", warmed: "dual-write" });

    await h.decorated.createRun(birthParams());

    expect(h.warmCalls()).toBe(1);
    expect(h.appends).toEqual([{ kind: "birth" }]);
  });

  it("does not mirror when the organisation really is off", async () => {
    // Warming must fetch the truth, not force a mirror.
    const h = harness({ cold: "dual-write", warmed: "off" });

    await h.decorated.createRun(birthParams());

    expect(h.warmCalls()).toBe(1);
    expect(h.appends).toEqual([]);
  });

  it("warms the cancelled-run birth path too", async () => {
    const h = harness({ cold: "off", warmed: "dual-write" });

    await h.decorated.createCancelledRun(birthParams());

    expect(h.warmCalls()).toBe(1);
    expect(h.appends).toEqual([{ kind: "birth" }]);
  });

  it("still births when the warm read fails, falling back to the position it already had", async () => {
    // A flag read that fails or times out must never fail a trigger. The old behaviour is the
    // fallback, not an error.
    const h = harness({ cold: "dual-write", warmed: "off", warmThrows: true });

    await expect(h.decorated.createRun(birthParams())).resolves.toBeDefined();

    expect(h.warmCalls()).toBe(1);
    // Cold answer stood, because the warm never landed.
    expect(h.appends).toEqual([{ kind: "birth" }]);
  });

  it("works against a resolver that offers no warm at all", async () => {
    // The seam is optional, so every existing resolver and test double keeps working.
    const h = harness({ cold: "dual-write", warmed: "off", offerWarm: false });

    await h.decorated.createRun(birthParams());

    expect(h.warmCalls()).toBe(0);
    expect(h.appends).toEqual([{ kind: "birth" }]);
  });
});
