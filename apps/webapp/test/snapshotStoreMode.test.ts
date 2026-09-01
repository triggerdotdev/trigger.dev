import { describe, expect, it, vi } from "vitest";
import type { SnapshotStoreMode } from "@internal/run-store";
import {
  createOrgModeSource,
  buildSnapshotStoreModeResolver,
  cachedOrgModeFor,
  NO_OVERRIDE,
} from "~/v3/snapshotStoreMode.server";

function build(opts: {
  globalMode?: SnapshotStoreMode;
  perOrg?: Record<string, SnapshotStoreMode>;
  envFloor?: SnapshotStoreMode;
  refresh?: (organizationId: string) => void;
}) {
  return buildSnapshotStoreModeResolver({
    globalMode: () => opts.globalMode,
    orgMode: {
      get: (id: string) => opts.perOrg?.[id],
      refresh: opts.refresh ?? (() => {}),
    },
    envFloor: opts.envFloor ?? "off",
  });
}

describe("snapshot store mode resolver", () => {
  it("falls back to the env floor when the global snapshot is cold", () => {
    expect(build({ envFloor: "off" }).resolve()).toBe("off");
    expect(build({ envFloor: "dual-write" }).resolve()).toBe("dual-write");
  });

  it("prefers the global flag over the floor", () => {
    expect(build({ globalMode: "redis-read", envFloor: "off" }).resolve()).toBe("redis-read");
  });

  it("prefers an organisation override over the global flag", () => {
    const r = build({ globalMode: "off", perOrg: { org_a: "dual-write" } });
    expect(r.resolve("org_a")).toBe("dual-write");
    expect(r.resolve("org_b")).toBe("off");
  });

  it("lets an organisation be off while the global flag is on", () => {
    const r = build({ globalMode: "dual-write", perOrg: { org_a: "off" } });
    expect(r.resolve("org_a")).toBe("off");
    expect(r.resolve("org_b")).toBe("dual-write");
  });

  it("serves the global answer on a cold organisation and schedules a refresh", () => {
    const refresh = vi.fn();
    const r = build({ globalMode: "dual-write", refresh });
    expect(r.resolve("org_cold")).toBe("dual-write");
    expect(refresh).toHaveBeenCalledWith("org_cold");
  });

  it("never lets a refresh failure reach the caller", () => {
    const refresh = vi.fn(() => {
      throw new Error("control plane unreachable");
    });
    const r = build({ globalMode: "off", refresh });
    expect(() => r.resolve("org_x")).not.toThrow();
    expect(r.resolve("org_x")).toBe("off");
  });

  it("resolves an unknown organisation to the global answer, never a throw", () => {
    const r = build({ globalMode: "off", perOrg: {} });
    expect(r.resolve("org_deleted")).toBe("off");
  });

  it("caches an absent override rather than nothing", () => {
    // Caching nothing means every organisation without an override re-queries on every write.
    expect(cachedOrgModeFor(undefined)).toBe(NO_OVERRIDE);
    expect(cachedOrgModeFor(null)).toBe(NO_OVERRIDE);
    expect(cachedOrgModeFor("not-a-mode")).toBe(NO_OVERRIDE);
    expect(cachedOrgModeFor("dual-write")).toBe("dual-write");
    expect(cachedOrgModeFor("redis-read")).toBe("redis-read");
    expect(cachedOrgModeFor("redis-only")).toBe("redis-only");
  });

  it("stops querying once an absent override is cached", () => {
    // Without a cached negative, every organisation with no override re-queries on every write,
    // which is every organisation until a ramp starts.
    const refresh = vi.fn();
    let cached: string | undefined;
    const r = buildSnapshotStoreModeResolver({
      globalMode: () => "off",
      orgMode: {
        get: () => cached as never,
        refresh: (id: string) => {
          refresh(id);
          cached = "__none__";
        },
      },
      envFloor: "off",
    });

    expect(r.resolve("org_a")).toBe("off");
    expect(refresh).toHaveBeenCalledTimes(1);

    expect(r.resolve("org_a")).toBe("off");
    expect(r.resolve("org_a")).toBe("off");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not consult the organisation source when no organisation is supplied", () => {
    const get = vi.fn(() => undefined);
    const r = buildSnapshotStoreModeResolver({
      globalMode: () => "redis-read",
      orgMode: { get, refresh: () => {} },
      envFloor: "off",
    });
    expect(r.resolve()).toBe("redis-read");
    expect(get).not.toHaveBeenCalled();
  });
});

describe("the org-scoped read routing", () => {
  function buildRead(opts: {
    globalMode?: SnapshotStoreMode;
    perOrg?: Record<string, SnapshotStoreMode>;
    runToOrg?: Record<string, string>;
    census?: { anyOrgReadEnabled: boolean; anyOrgRedisOnly: boolean };
  }) {
    return buildSnapshotStoreModeResolver({
      globalMode: () => opts.globalMode,
      orgMode: {
        get: (id: string) => opts.perOrg?.[id],
        refresh: () => {},
      },
      runOrg: { resolve: (runId: string) => opts.runToOrg?.[runId] },
      census: opts.census
        ? {
            anyOrgReadEnabled: () => opts.census!.anyOrgReadEnabled,
            anyOrgRedisOnly: () => opts.census!.anyOrgRedisOnly,
          }
        : undefined,
      envFloor: "off",
    });
  }

  it("routes a run in a redis-read org to that org's read position", () => {
    const r = buildRead({
      globalMode: "off",
      perOrg: { org_a: "redis-read" },
      runToOrg: { run_1: "org_a" },
    });
    expect(r.readModeFor?.("run_1")).toBe("redis-read");
  });

  it("returns undefined for a run whose org cannot be resolved, so the decorator falls back", () => {
    const r = buildRead({ globalMode: "redis-read", runToOrg: {} });
    expect(r.readModeFor?.("run_unknown")).toBeUndefined();
  });

  it("returns the global answer for a resolved run whose org has no override", () => {
    const r = buildRead({ globalMode: "dual-write", runToOrg: { run_1: "org_a" }, perOrg: {} });
    expect(r.readModeFor?.("run_1")).toBe("dual-write");
  });

  it("delegates the cheap read gates to the census", () => {
    const r = buildRead({
      globalMode: "off",
      census: { anyOrgReadEnabled: true, anyOrgRedisOnly: false },
    });
    expect(r.anyOrgReadEnabled?.()).toBe(true);
    expect(r.anyOrgRedisOnly?.()).toBe(false);
  });

  it("is inert when no run→org source or census is wired", () => {
    const r = buildSnapshotStoreModeResolver({
      globalMode: () => "off",
      orgMode: { get: () => undefined, refresh: () => {} },
      envFloor: "off",
    });
    expect(r.readModeFor?.("run_1")).toBeUndefined();
    expect(r.anyOrgReadEnabled?.()).toBe(false);
    expect(r.anyOrgRedisOnly?.()).toBe(false);
  });
});

describe("a saved organisation dial survives a lagging replica", () => {
  type Deferred = { resolve: (v: unknown) => void; promise: Promise<unknown> };

  function deferred(): Deferred {
    let resolve!: (v: unknown) => void;
    const promise = new Promise<unknown>((r) => (resolve = r));
    return { resolve, promise };
  }

  function clientFor(read: () => Promise<unknown>) {
    return { organization: { findFirst: () => read() as never } } as never;
  }

  it("does not let a replica read that starts after the save re-cache the old value", async () => {
    // The primary carries the saved value; the replica is still lagging and carries the old one.
    const primary = deferred();
    const replica = deferred();

    const source = createOrgModeSource({
      primary: clientFor(() => primary.promise),
      replica: clientFor(() => replica.promise),
    });

    // The save path invalidates, which drops the cache and reads the primary.
    source.invalidate("org_1");
    // A concurrent write for the same organisation misses the now-empty cache and warms off-path.
    source.refresh("org_1");

    // The primary lands first with the saved value.
    primary.resolve({ featureFlags: { snapshotStoreOrgMode: "dual-write" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(source.get("org_1")).toBe("dual-write");

    // Then the lagging replica lands with the pre-save value. It must not win.
    replica.resolve({ featureFlags: {} });
    await new Promise((r) => setTimeout(r, 0));

    expect(source.get("org_1")).toBe("dual-write");
  });
  it("keeps the save protected when two invalidations for one organisation overlap", async () => {
    // primaryPending was a Set, so the FIRST primary read's finally cleared it while the SECOND was
    // still in flight. A refresh arriving in that window then started a replica read carrying the
    // current generation, so the generation guard could not discard it, and a lagging replica put
    // the pre-save value back for a full cache TTL.
    const firstPrimary = deferred();
    const secondPrimary = deferred();
    const replica = deferred();
    const primaries = [firstPrimary, secondPrimary];
    let primaryCalls = 0;

    const source = createOrgModeSource({
      primary: clientFor(() => primaries[primaryCalls++]!.promise),
      replica: clientFor(() => replica.promise),
    });

    // Two saves for the same organisation, overlapping.
    source.invalidate("org_1");
    source.invalidate("org_1");

    // The FIRST primary read completes. The second is still outstanding, so the organisation must
    // still count as pending.
    firstPrimary.resolve({ featureFlags: { snapshotStoreOrgMode: "off" } });
    await new Promise((r) => setTimeout(r, 0));

    // A concurrent read arrives while the second save is still reading. It must not start a replica
    // read, because the authoritative answer is still on its way.
    source.refresh("org_1");

    // The second save lands with the value that must win.
    secondPrimary.resolve({ featureFlags: { snapshotStoreOrgMode: "dual-write" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(source.get("org_1")).toBe("dual-write");

    // NOW the lagging replica lands, carrying the pre-save value. It shares the second save's
    // generation, so the generation guard cannot discard it: only never having started can stop it.
    replica.resolve({ featureFlags: {} });
    await new Promise((r) => setTimeout(r, 0));

    expect(source.get("org_1")).toBe("dual-write");
  });
});

describe("warming the organisation dial before a birth", () => {
  type Deferred = { resolve: (v: unknown) => void; promise: Promise<unknown> };
  function deferred(): Deferred {
    let resolve!: (v: unknown) => void;
    const promise = new Promise<unknown>((r) => (resolve = r));
    return { resolve, promise };
  }
  function clientFor(read: () => Promise<unknown>) {
    return { organization: { findFirst: () => read() as never } } as never;
  }

  it("resolves once the organisation's value is cached, so a birth sees the truth", async () => {
    const replica = deferred();
    const source = createOrgModeSource({
      primary: clientFor(() => Promise.resolve({})),
      replica: clientFor(() => replica.promise),
    });

    expect(source.get("org_1")).toBeUndefined();

    const warming = source.warm("org_1");
    replica.resolve({ featureFlags: { snapshotStoreOrgMode: "dual-write" } });
    await warming;

    // The point of the whole exercise: after warm, the cache holds the real value, so the
    // synchronous resolve a birth then performs no longer falls back to the global position.
    expect(source.get("org_1")).toBe("dual-write");
  });

  it("costs nothing when the value is already cached", async () => {
    let reads = 0;
    const source = createOrgModeSource({
      primary: clientFor(() => Promise.resolve({})),
      replica: clientFor(() => {
        reads += 1;
        return Promise.resolve({ featureFlags: { snapshotStoreOrgMode: "off" } });
      }),
    });

    await source.warm("org_1");
    expect(reads).toBe(1);
    expect(source.get("org_1")).toBe("off");

    // A warm organisation is the common case once it has any traffic, and must not re-read.
    await source.warm("org_1");
    expect(reads).toBe(1);
  });

  it("gives up rather than holding a birth open on a slow read", async () => {
    // A birth is on the trigger path and the caller may already hold an open transaction, so this
    // must be bounded. Giving up restores the previous behaviour, it does not fail the trigger.
    const neverResolves = new Promise<unknown>(() => {});
    const source = createOrgModeSource({
      primary: clientFor(() => Promise.resolve({})),
      replica: clientFor(() => neverResolves),
    });

    const started = Date.now();
    await expect(source.warm("org_1")).resolves.toBeUndefined();
    const elapsed = Date.now() - started;

    // Bounded, and nowhere near indefinite.
    expect(elapsed).toBeLessThan(2_000);
    // Still unknown, so the synchronous resolve falls back exactly as it did before.
    expect(source.get("org_1")).toBeUndefined();
  });
  it("keeps replica refreshes out after a FAILED primary read", async () => {
    // load() swallows its own errors, so a rejected primary read used to clear primaryPending with
    // nothing cached. A refresh could then read a lagging replica carrying the current generation,
    // which the generation guard cannot discard, restoring the pre-save value for a cache lifetime.
    const primary = deferred();
    const replica = deferred();
    const source = createOrgModeSource({
      primary: clientFor(() => primary.promise),
      replica: clientFor(() => replica.promise),
    });

    source.invalidate("org_1");

    // The primary read FAILS.
    primary.resolve(Promise.reject(new Error("primary unavailable")) as never);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // A refresh arriving now must not start a replica read, because no primary answer ever landed.
    source.refresh("org_1");
    replica.resolve({ featureFlags: { snapshotStoreOrgMode: "off" } });
    await new Promise((r) => setTimeout(r, 0));

    // Nothing cached: the resolver falls back to the deployment-wide position, which is the safe
    // answer, rather than serving a stale replica value as though it were the saved one.
    expect(source.get("org_1")).toBeUndefined();
  });
});
