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
    expect(cachedOrgModeFor("redis-read")).toBe(NO_OVERRIDE);
    expect(cachedOrgModeFor("dual-write")).toBe("dual-write");
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
});
