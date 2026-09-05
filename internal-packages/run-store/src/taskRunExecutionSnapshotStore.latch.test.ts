// `off` was not inert. A transition must ask whether its run is resident, and the keyspace is the
// only record of that, so at `off` AFTER a ramp every transition still has to ask or a resident
// run's head freezes while Postgres moves on.
//
// A transition may therefore be skipped only when nothing of this org's could be resident. A run is
// resident only if its org's dial was non-off at its birth, i.e. the global dial had ever gone
// non-off OR the org itself was ever enabled. So the skip is sound only when the global dial has
// NEVER been non-off (globalModeEverEnabled() === false) AND this org is DEFINITELY never-enabled
// (orgDefinitelyNeverEnabled(org) === true). Any uncertainty falls to "probe".
import { describe, expect, it } from "vitest";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type { SnapshotStoreModeResolver } from "./taskRunExecutionSnapshotStore.js";
import type { RedisSnapshotStore } from "./redisSnapshotStore.js";
import type { RunStore } from "./types.js";

const SCOPE = {
  environmentId: "env_1",
  environmentType: "PRODUCTION",
  projectId: "proj_1",
  organizationId: "org_1",
} as const;

function harness(opts: {
  mode: "off" | "dual-write";
  globalModeEverEnabled?: boolean;
  orgDefinitelyNeverEnabled?: (organizationId: string) => boolean;
}) {
  const touched: string[] = [];
  const redis = new Proxy({} as RedisSnapshotStore, {
    get: (_t, prop) => {
      return (...__: unknown[]) => {
        touched.push(String(prop));
        return Promise.resolve({ outcome: "written", seq: 1 });
      };
    },
  });
  const delegate = new Proxy({} as Record<string, unknown>, {
    get: () => () => Promise.resolve({}),
  }) as unknown as RunStore;

  const modeResolver: SnapshotStoreModeResolver = {
    resolve: () => opts.mode,
    ...(opts.globalModeEverEnabled !== undefined && {
      globalModeEverEnabled: () => opts.globalModeEverEnabled!,
    }),
    ...(opts.orgDefinitelyNeverEnabled && {
      orgDefinitelyNeverEnabled: opts.orgDefinitelyNeverEnabled,
    }),
  };

  const decorated = new TaskRunExecutionSnapshotStore(delegate, {
    store: redis,
    mode: opts.mode,
    modeResolver,
  });
  return { decorated, touched };
}

/** A completion whose snapshot carries a chosen organisation id. */
function completionForOrg(organizationId: string) {
  return { ...completion, snapshot: { ...completion.snapshot, organizationId } };
}

const completion = {
  completedAt: new Date(),
  outputType: "application/json",
  usageDurationMs: 1,
  costInCents: 0,
  snapshot: {
    executionStatus: "FINISHED" as const,
    description: "done",
    runStatus: "COMPLETED_SUCCESSFULLY" as const,
    attemptNumber: 1,
    ...SCOPE,
  },
};

describe("the sound transition skip", () => {
  it("touches the store NOT AT ALL for a definitely-never org while the global dial has never moved", async () => {
    // The assertion the whole change exists for: no keyspace can exist for this org, so no probe.
    const h = harness({
      mode: "dual-write",
      globalModeEverEnabled: false,
      orgDefinitelyNeverEnabled: () => true,
    });

    await h.decorated.completeAttemptSuccess("run_1", completionForOrg("org_a"), {
      select: { id: true },
    });

    expect(h.touched).toEqual([]);
  });

  it("still probes an org that has ever been enabled", async () => {
    // orgDefinitelyNeverEnabled is false for an org that may hold resident runs, so it keeps asking.
    const h = harness({
      mode: "dual-write",
      globalModeEverEnabled: false,
      orgDefinitelyNeverEnabled: (org) => org !== "org_a",
    });

    await h.decorated.completeAttemptSuccess("run_1", completionForOrg("org_a"), {
      select: { id: true },
    });

    expect(h.touched).toContain("append");
  });

  it("never skips once the global dial has ever been non-off, even for a definitely-never org", async () => {
    // Non-negotiable. Once the global dial has moved, resident runs exist, and suppressing their
    // transitions freezes a head while Postgres advances. The global latch beats the per-org one.
    const h = harness({
      mode: "off",
      globalModeEverEnabled: true,
      orgDefinitelyNeverEnabled: () => true,
    });

    await h.decorated.completeAttemptSuccess("run_1", completionForOrg("org_a"), {
      select: { id: true },
    });

    expect(h.touched).toContain("append");
  });

  it("never skips when the organisation is undefined", () => {
    // No org id means orgDefinitelyNeverEnabled cannot be consulted, so an unknown org errs toward
    // asking. The per-org term is only reached once an org id is supplied.
    const h = harness({
      mode: "dual-write",
      globalModeEverEnabled: false,
      orgDefinitelyNeverEnabled: () => true,
    });

    expect(h.decorated.writesRedisForTransitionTest()).toBe(true);
    expect(h.decorated.writesRedisForTransitionTest("org_a")).toBe(false);
  });

  it("asks when the resolver offers no latch signals, so an unwired deployment is unchanged", async () => {
    const h = harness({ mode: "off" });

    await h.decorated.completeAttemptSuccess("run_1", completion, { select: { id: true } });

    expect(h.touched).toContain("append");
  });

  it("asks when only one of the two signals permits a skip", () => {
    // Both halves are required. A cold census (orgDefinitelyNeverEnabled false) with an unmoved
    // global dial must still probe, and vice versa.
    const globalOnly = harness({
      mode: "off",
      globalModeEverEnabled: false,
      orgDefinitelyNeverEnabled: () => false,
    });
    expect(globalOnly.decorated.writesRedisForTransitionTest("org_a")).toBe(true);

    const orgOnly = harness({
      mode: "off",
      globalModeEverEnabled: true,
      orgDefinitelyNeverEnabled: () => true,
    });
    expect(orgOnly.decorated.writesRedisForTransitionTest("org_a")).toBe(true);
  });
});
