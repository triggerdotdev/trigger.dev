// `off` was not inert. A transition must ask whether its run is resident, and the keyspace is the
// only record of that, so at `off` AFTER a ramp every transition still has to ask or a resident
// run's head freezes while Postgres moves on.
//
// Before any ramp, nothing CAN be resident: only a birth creates a keyspace and every birth was
// refused. So the question has one possible answer and asking it is pure cost. Measured: 2 per cent
// with a healthy endpoint, four times the run duration with a slow one, for every run, and it did
// not decay.
//
// The latch is one way. Unset means this deployment has never enabled the store, so transitions skip
// it entirely. Once set it is never cleared, and `off` returns to meaning "drain".
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
  everEnabled?: boolean;
  everEnabledForOrg?: (organizationId: string) => boolean;
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
    ...(opts.everEnabled !== undefined && { everEnabled: () => opts.everEnabled! }),
    ...(opts.everEnabledForOrg && { everEnabledForOrg: opts.everEnabledForOrg }),
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

describe("the residency latch", () => {
  it("a transition touches the store NOT AT ALL while the latch is unset", async () => {
    const h = harness({ mode: "off", everEnabled: false });

    await h.decorated.completeAttemptSuccess("run_1", completion, { select: { id: true } });

    // The assertion the whole change exists for: no probe, so Redis is off the run path entirely.
    expect(h.touched).toEqual([]);
  });

  it("a transition still asks once the latch is set, even at off", async () => {
    // Non-negotiable. A run resident from an earlier ramp must keep mirroring, or its head freezes
    // and the remedy becomes worse than the fault.
    const h = harness({ mode: "off", everEnabled: true });

    await h.decorated.completeAttemptSuccess("run_1", completion, { select: { id: true } });

    expect(h.touched).toContain("append");
  });

  it("asks when the resolver offers no latch, so an unlatched deployment is unchanged", async () => {
    const h = harness({ mode: "off" });

    await h.decorated.completeAttemptSuccess("run_1", completion, { select: { id: true } });

    expect(h.touched).toContain("append");
  });

  it("never suppresses a transition once the dial itself is past off", async () => {
    // Belt and braces: the guard makes this state unreachable, but if it ever occurred, suppressing
    // transitions while births are mirroring is the one combination that strands a head.
    const h = harness({ mode: "dual-write", everEnabled: false });

    await h.decorated.completeAttemptSuccess("run_1", completion, { select: { id: true } });

    expect(h.touched).toContain("append");
  });
});

describe("the per-organisation latch", () => {
  it("keeps redis off a never-enabled org's transition path", async () => {
    // Deployment-wide latch unset AND this org's latch unset: nothing can be resident for it, so the
    // probe is pure cost even though the dial has moved past off for the ramping orgs.
    const h = harness({
      mode: "dual-write",
      everEnabled: false,
      everEnabledForOrg: () => false,
    });

    await h.decorated.completeAttemptSuccess("run_1", completionForOrg("org_a"), {
      select: { id: true },
    });

    expect(h.touched).toEqual([]);
  });

  it("still probes an org whose latch is set", async () => {
    // An org that has ever been enabled may hold resident runs, so its transitions must keep asking.
    const h = harness({
      mode: "dual-write",
      everEnabled: false,
      everEnabledForOrg: (org) => org === "org_a",
    });

    await h.decorated.completeAttemptSuccess("run_1", completionForOrg("org_a"), {
      select: { id: true },
    });

    expect(h.touched).toContain("append");
  });

  it("falls back to the global-only latch when the org is undefined", () => {
    // No org id means the per-org latch cannot be consulted, so an unknown org errs toward asking:
    // the deployment-wide check alone decides, exactly as before this latch existed.
    const h = harness({
      mode: "dual-write",
      everEnabled: false,
      everEnabledForOrg: () => false,
    });

    // Past off with the global latch unset, so the global-only check probes; the per-org term is
    // only reached once an org id is supplied.
    expect(h.decorated.writesRedisForTransitionTest()).toBe(true);
    expect(h.decorated.writesRedisForTransitionTest("org_a")).toBe(false);
  });
});
