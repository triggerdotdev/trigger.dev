import { describe, expect, it, vi } from "vitest";
import type { SnapshotStoreMode } from "@internal/run-store";
import {
  buildSnapshotStoreModeResolver,
  NO_OVERRIDE,
  snapshotStoreAnyOrgReadEnabled,
  snapshotStoreAnyOrgRedisOnly,
  snapshotStoreIsCohortMember,
  snapshotStoreOrgDefinitelyNeverEnabled,
} from "~/v3/snapshotStoreMode.server";

/** A cold registry is modelled by `dials: undefined`; a loaded one by a (possibly empty) map. */
type Dials = Record<string, SnapshotStoreMode> | undefined;

/**
 * Builds the resolver the way production wires it: every org-scoped answer derives from the polled
 * dial map. `dials` undefined models a cold registry; the map value (including "off") is authoritative
 * when present, and an absent org reads as NO_OVERRIDE so `resolve` falls back to the global dial.
 */
function build(opts: {
  globalMode?: SnapshotStoreMode;
  dials?: Dials;
  runToOrg?: Record<string, string>;
  envFloor?: SnapshotStoreMode;
}) {
  const dials = opts.dials;
  return buildSnapshotStoreModeResolver({
    globalMode: () => opts.globalMode,
    orgDefinitelyNeverEnabled: (id) => snapshotStoreOrgDefinitelyNeverEnabled(dials, id),
    orgMode: {
      get: (id) => dials?.[id] ?? NO_OVERRIDE,
      refresh: () => {},
    },
    runOrg: opts.runToOrg
      ? {
          resolve: (runId: string) => opts.runToOrg?.[runId],
        }
      : undefined,
    census: {
      anyOrgReadEnabled: () => snapshotStoreAnyOrgReadEnabled(dials),
      anyOrgRedisOnly: () => snapshotStoreAnyOrgRedisOnly(dials),
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

  it("prefers an organisation dial over the global flag", () => {
    const r = build({ globalMode: "off", dials: { org_a: "dual-write" } });
    expect(r.resolve("org_a")).toBe("dual-write");
    expect(r.resolve("org_b")).toBe("off");
  });

  it("lets an organisation be off while the global flag is on", () => {
    const r = build({ globalMode: "dual-write", dials: { org_a: "off" } });
    expect(r.resolve("org_a")).toBe("off");
    expect(r.resolve("org_b")).toBe("dual-write");
  });

  it("resolves an org absent from the map to the global answer", () => {
    const r = build({ globalMode: "dual-write", dials: {} });
    expect(r.resolve("org_absent")).toBe("dual-write");
  });

  it("resolves any org to the global answer while the map is cold", () => {
    const r = build({ globalMode: "dual-write", dials: undefined });
    expect(r.resolve("org_cold")).toBe("dual-write");
  });

  it("resolves an unknown organisation to the global answer, never a throw", () => {
    const r = build({ globalMode: "off", dials: {} });
    expect(() => r.resolve("org_deleted")).not.toThrow();
    expect(r.resolve("org_deleted")).toBe("off");
  });

  it("does not consult the organisation source when no organisation is supplied", () => {
    const get = vi.fn(() => NO_OVERRIDE as const);
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
  it("routes a run in a redis-read org to that org's read position", () => {
    const r = build({
      globalMode: "off",
      dials: { org_a: "redis-read" },
      runToOrg: { run_1: "org_a" },
    });
    expect(r.readModeFor?.("run_1")).toBe("redis-read");
  });

  it("returns undefined for a run whose org cannot be resolved, so the decorator falls back", () => {
    const r = build({ globalMode: "redis-read", runToOrg: {} });
    expect(r.readModeFor?.("run_unknown")).toBeUndefined();
  });

  it("returns the global answer for a resolved run whose org is absent from the map", () => {
    const r = build({ globalMode: "dual-write", runToOrg: { run_1: "org_a" }, dials: {} });
    expect(r.readModeFor?.("run_1")).toBe("dual-write");
  });

  it("delegates the cheap read gates to the map-derived census", () => {
    const r = build({ globalMode: "off", dials: { org_a: "redis-read" } });
    expect(r.anyOrgReadEnabled?.()).toBe(true);
    expect(r.anyOrgRedisOnly?.()).toBe(false);
  });

  it("is inert when no run→org source or census is wired", () => {
    const r = buildSnapshotStoreModeResolver({
      globalMode: () => "off",
      orgMode: { get: () => NO_OVERRIDE, refresh: () => {} },
      envFloor: "off",
    });
    expect(r.readModeFor?.("run_1")).toBeUndefined();
    expect(r.anyOrgReadEnabled?.()).toBe(false);
    expect(r.anyOrgRedisOnly?.()).toBe(false);
  });
});

describe("the map-derived aggregates and census accessors", () => {
  it("anyOrgReadEnabled derives from values, cold default TRUE", () => {
    // Cold: no map yet, so err toward resolving per-org reads rather than silently suppressing them.
    expect(snapshotStoreAnyOrgReadEnabled(undefined)).toBe(true);
    // Loaded but empty, or only dual-write/off: no read position, so false.
    expect(snapshotStoreAnyOrgReadEnabled({})).toBe(false);
    expect(snapshotStoreAnyOrgReadEnabled({ a: "dual-write", b: "off" })).toBe(false);
    // A read position anywhere flips it true.
    expect(snapshotStoreAnyOrgReadEnabled({ a: "redis-read" })).toBe(true);
    expect(snapshotStoreAnyOrgReadEnabled({ a: "off", b: "redis-only" })).toBe(true);
  });

  it("anyOrgRedisOnly derives from values, cold default FALSE", () => {
    // Cold: err toward Postgres fallback, which is authoritative.
    expect(snapshotStoreAnyOrgRedisOnly(undefined)).toBe(false);
    expect(snapshotStoreAnyOrgRedisOnly({})).toBe(false);
    expect(snapshotStoreAnyOrgRedisOnly({ a: "redis-read", b: "dual-write" })).toBe(false);
    expect(snapshotStoreAnyOrgRedisOnly({ a: "redis-only" })).toBe(true);
  });

  it("isCohortMember derives from the org's value, cold default FALSE", () => {
    expect(snapshotStoreIsCohortMember(undefined, "org_a")).toBe(false);
    expect(snapshotStoreIsCohortMember({}, "org_a")).toBe(false);
    expect(snapshotStoreIsCohortMember({ org_a: "dual-write" }, "org_a")).toBe(true);
    expect(snapshotStoreIsCohortMember({ org_a: "redis-only" }, "org_a")).toBe(true);
  });

  it("orgDefinitelyNeverEnabled derives from ABSENCE, cold default FALSE", () => {
    // Cold: not definite, so the caller keeps probing.
    expect(snapshotStoreOrgDefinitelyNeverEnabled(undefined, "org_a")).toBe(false);
    // Loaded and the key is absent: a definite negative.
    expect(snapshotStoreOrgDefinitelyNeverEnabled({}, "org_a")).toBe(true);
    expect(snapshotStoreOrgDefinitelyNeverEnabled({ org_b: "dual-write" }, "org_a")).toBe(true);
    // Present at any value is NOT a definite negative.
    expect(snapshotStoreOrgDefinitelyNeverEnabled({ org_a: "dual-write" }, "org_a")).toBe(false);
  });

  it("a retained off entry is present but neither a cohort member nor a read enabler", () => {
    const dials: Dials = { org_off: "off" };
    // Present, so NOT a definite never-enabled negative (presence is the one-way latch).
    expect(snapshotStoreOrgDefinitelyNeverEnabled(dials, "org_off")).toBe(false);
    // But its value is off, so it is not a cohort member and does not enable reads.
    expect(snapshotStoreIsCohortMember(dials, "org_off")).toBe(false);
    expect(snapshotStoreAnyOrgReadEnabled(dials)).toBe(false);
    expect(snapshotStoreAnyOrgRedisOnly(dials)).toBe(false);
  });

  it("the resolver reflects the map values through its census and definite-negative accessors", () => {
    const r = build({ globalMode: "off", dials: { org_read: "redis-read", org_off: "off" } });
    expect(r.anyOrgReadEnabled?.()).toBe(true);
    expect(r.anyOrgRedisOnly?.()).toBe(false);
    expect(r.orgDefinitelyNeverEnabled?.("org_off")).toBe(false);
    expect(r.orgDefinitelyNeverEnabled?.("org_absent")).toBe(true);
  });
});
