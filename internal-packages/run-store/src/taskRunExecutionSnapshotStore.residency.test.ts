import { describe, expect, it } from "vitest";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type {
  SnapshotStoreMode,
  SnapshotStoreModeResolver,
} from "./taskRunExecutionSnapshotStore.js";
import type { RunStore } from "./types.js";

// A run's store is chosen once, at birth, and never changes for that run's life. The dial may move
// underneath it, and the per-organisation override may flip, and neither may divert a run that is
// already running: that is a mid-life store switch, and it leaves the Redis head frozen while
// Postgres advances.
function resolverOf(perOrg: Record<string, SnapshotStoreMode>, global: SnapshotStoreMode) {
  return {
    resolve: (organizationId?: string) => (organizationId && perOrg[organizationId]) || global,
  } satisfies SnapshotStoreModeResolver;
}

function storeWith(mode: SnapshotStoreMode, resolver?: SnapshotStoreModeResolver) {
  return new TaskRunExecutionSnapshotStore({} as unknown as RunStore, {
    store: {} as never,
    mode,
    ...(resolver && { modeResolver: resolver }),
  });
}

describe("store residency is decided at birth", () => {
  it("lets the per-organisation override decide a BIRTH", () => {
    const s = storeWith("off", resolverOf({ org_off: "off" }, "dual-write"));
    expect(s.writesRedisForBirthTest("org_off")).toBe(false);
    expect(s.writesRedisForBirthTest("org_other")).toBe(true);
  });

  it("does NOT let the per-organisation override decide a TRANSITION", () => {
    // The run is already resident or already absent. Asking the organisation again is what allows a
    // run to change stores half way through its life.
    const s = storeWith("off", resolverOf({ org_off: "off" }, "dual-write"));
    expect(s.writesRedisForTransitionTest("org_off")).toBe(true);
    expect(s.writesRedisForTransitionTest("org_other")).toBe(true);
  });

  it("stops every transition when the deployment-wide dial is off", () => {
    // The global position is the kill switch, and it is allowed to stop writes outright.
    const s = storeWith("off", resolverOf({ org_on: "dual-write" }, "off"));
    expect(s.writesRedisForTransitionTest("org_on")).toBe(false);
    expect(s.writesRedisForTransitionTest(undefined)).toBe(false);
  });

  it("keeps transitions on for a resident run at every position past off", () => {
    for (const m of ["dual-write", "redis-read", "redis-only"] as const) {
      const s = storeWith("off", resolverOf({ org_off: "off" }, m));
      expect(s.writesRedisForTransitionTest("org_off")).toBe(true);
    }
  });
});
