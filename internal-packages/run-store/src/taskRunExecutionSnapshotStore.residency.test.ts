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

  it("does NOT let the dial decide a TRANSITION, at either scope", () => {
    // The run is already resident or already absent. Asking the dial again is what allows a run to
    // change stores half way through its life, and the seam takes no organisation id so the
    // compiler holds that line. Stopping writes outright is the halt switch; see the hardStop suite.
    expect(
      storeWith("off", resolverOf({ org_off: "off" }, "dual-write")).writesRedisForTransitionTest()
    ).toBe(true);
    expect(
      storeWith("off", resolverOf({ org_on: "dual-write" }, "off")).writesRedisForTransitionTest()
    ).toBe(true);
  });

  it("keeps transitions on for a resident run at every position past off", () => {
    for (const m of ["dual-write", "redis-read", "redis-only"] as const) {
      const s = storeWith("off", resolverOf({ org_off: "off" }, m));
      expect(s.writesRedisForTransitionTest()).toBe(true);
    }
  });
});
