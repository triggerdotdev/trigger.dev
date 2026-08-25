import { afterEach, describe, expect, it, vi } from "vitest";

// A socket-level assertion is impossible in this suite: test/setup.ts mocks ioredis with a
// LazyRedis subclass that forces lazyConnect, so no client ever dials and a "no connection was
// opened" test would pass even if the gate were broken. The property that does hold, and the one
// that matters, is that no client OBJECT is constructed — an unconstructed client cannot dial.
async function importInstanceModule() {
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__trigger_singletons;
  return import("~/v3/snapshotStoreInstance.server");
}

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  delete (globalThis as Record<string, unknown>).__trigger_singletons;
});

describe("snapshot store construction gate", () => {
  it("constructs nothing when the snapshot-store host is unset", async () => {
    // The generic pair is set by test/setup.ts, so this also covers the no-fallback rule: if any
    // variable in the block fell back to REDIS_HOST, the store would be constructed here.
    vi.stubEnv("RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST", "");

    const mod = await importInstanceModule();
    const sentinel = {} as never;

    expect(mod.decorateWithSnapshotStore(sentinel)).toBe(sentinel);
    expect(mod.getSnapshotSweepClient()).toBeUndefined();
    expect(mod.getSnapshotStoreConfig().configured).toBe(false);
  });

  it("constructs the decorator and the sweep client once the host is set", async () => {
    vi.stubEnv("RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST", "127.0.0.1");
    vi.stubEnv("RUN_ENGINE_SNAPSHOT_STORE_REDIS_PORT", "6379");
    vi.stubEnv("RUN_ENGINE_SNAPSHOT_STORE_REDIS_TLS_DISABLED", "true");

    const mod = await importInstanceModule();
    const sentinel = {} as never;

    // Without this the negative above is satisfiable by an import that throws.
    expect(mod.decorateWithSnapshotStore(sentinel)).not.toBe(sentinel);
    expect(mod.getSnapshotSweepClient()).toBeDefined();
    expect(mod.getSnapshotStoreConfig().configured).toBe(true);

    await mod.quitSnapshotStoreClients();
  });

  it("reports the resolved configuration for the boot log line", async () => {
    vi.stubEnv("RUN_ENGINE_SNAPSHOT_STORE_REDIS_HOST", "127.0.0.1");
    vi.stubEnv("RUN_ENGINE_SNAPSHOT_STORE_REDIS_TLS_DISABLED", "true");
    vi.stubEnv("RUN_ENGINE_SNAPSHOT_STORE_COMPLETED_TTL_MS", "1000");
    vi.stubEnv("RUN_ENGINE_SNAPSHOT_STORE_ORPHAN_AGE_MS", "2000");

    const mod = await importInstanceModule();
    const config = mod.getSnapshotStoreConfig();

    expect(config).toMatchObject({
      configured: true,
      mode: "off",
      completedTtlMs: 1000,
      orphanAgeMs: 2000,
      keyPrefix: "engine:",
      clusterMode: false,
    });

    await mod.quitSnapshotStoreClients();
  });
});
