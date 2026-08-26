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
    expect(store.writesRedisForTest("org_a")).toBe(true);
    expect(store.writesRedisForTest("org_b")).toBe(false);
  });

  it("lets an organisation be off while the global answer is on", () => {
    const store = storeWith({ modeResolver: resolverOf({ org_a: "off" }, "dual-write") });
    expect(store.writesRedisForTest("org_a")).toBe(false);
    expect(store.writesRedisForTest("org_b")).toBe(true);
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
    expect(store.writesRedisForTest()).toBe(true);
  });
});
