import { describe, expect, it } from "vitest";
import {
  TaskRunExecutionSnapshotStore,
  type SnapshotStoreMode,
  type SnapshotStoreModeResolver,
} from "./taskRunExecutionSnapshotStore.js";

function storeWith(options: {
  mode?: SnapshotStoreMode;
  modeResolver?: SnapshotStoreModeResolver;
}) {
  return new TaskRunExecutionSnapshotStore({} as never, {
    store: {} as never,
    ...options,
  });
}

function resolverOf(perOrg: Record<string, SnapshotStoreMode>, global: SnapshotStoreMode) {
  return { resolve: (orgId?: string) => (orgId ? (perOrg[orgId] ?? global) : global) };
}

// These assert the per-organisation contract, which now governs BIRTHS only: a birth fixes the
// run's store for life. Transitions deliberately ignore the organisation, and that is asserted in
// taskRunExecutionSnapshotStore.residency.test.ts.
describe("TaskRunExecutionSnapshotStore mode resolution", () => {
  it("prefers the resolver over the static mode", () => {
    const store = storeWith({ mode: "off", modeResolver: resolverOf({}, "dual-write") });
    expect(store.mode).toBe("dual-write");
  });

  it("falls back to the static mode when no resolver is supplied", () => {
    expect(storeWith({ mode: "redis-read" }).mode).toBe("redis-read");
  });

  it("defaults to off with neither", () => {
    expect(storeWith({}).mode).toBe("off");
  });

  it("resolves per organisation", () => {
    const store = storeWith({ modeResolver: resolverOf({ org_a: "dual-write" }, "off") });
    expect(store.writesRedisForBirthTest("org_a")).toBe(true);
    expect(store.writesRedisForBirthTest("org_b")).toBe(false);
  });

  it("lets an organisation be off while the global answer is on", () => {
    const store = storeWith({ modeResolver: resolverOf({ org_a: "off" }, "dual-write") });
    expect(store.writesRedisForBirthTest("org_a")).toBe(false);
    expect(store.writesRedisForBirthTest("org_b")).toBe(true);
  });

  it("sees a resolver answer that changes after construction", () => {
    let current: SnapshotStoreMode = "off";
    const store = storeWith({ modeResolver: { resolve: () => current } });
    expect(store.mode).toBe("off");
    current = "dual-write";
    expect(store.mode).toBe("dual-write");
  });

  it("resolves the global answer when no organisation is supplied", () => {
    const store = storeWith({ modeResolver: resolverOf({ org_a: "off" }, "redis-read") });
    expect(store.writesRedisForBirthTest()).toBe(true);
  });

  it("resolves the fatal-birth decision per organisation, not globally", () => {
    // A lost birth append is fatal only where Postgres holds nothing. An organisation still on a
    // dual-write position must not have its run creation failed by the global position.
    const store = storeWith({
      modeResolver: resolverOf({ org_dual: "dual-write" }, "redis-only"),
    });

    expect(store.modeForTest("org_dual")).toBe("dual-write");
    expect(store.modeForTest("org_other")).toBe("redis-only");
    expect(store.modeForTest()).toBe("redis-only");
  });
});
