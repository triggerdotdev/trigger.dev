import { describe, expect, it } from "vitest";
import {
  clearedOrgFlagsPreservingLatch,
  FEATURE_FLAG,
  stampSnapshotStoreOrgEverEnabled,
  withoutOrgForbiddenSnapshotKeys,
} from "~/v3/featureFlags";
import { createOrgModeSource } from "~/v3/snapshotStoreMode.server";

const MODE = FEATURE_FLAG.snapshotStoreOrgMode;
const LATCH = FEATURE_FLAG.snapshotStoreOrgEverEnabled;

describe("stampSnapshotStoreOrgEverEnabled (one-way per-org latch)", () => {
  it("latches true when the resulting dial moves past off", () => {
    for (const mode of ["dual-write", "redis-read", "redis-only"]) {
      const stamped = stampSnapshotStoreOrgEverEnabled(null, { [MODE]: mode });
      expect(stamped[LATCH], mode).toBe(true);
    }
  });

  it("keeps the latch true when the org is set back to off (one-way)", () => {
    const stamped = stampSnapshotStoreOrgEverEnabled({ [LATCH]: true }, { [MODE]: "off" });
    expect(stamped[LATCH]).toBe(true);
  });

  it("carries an existing latch forward on an unrelated save that omits the dial", () => {
    const stamped = stampSnapshotStoreOrgEverEnabled({ [LATCH]: true }, { someOther: "flag" });
    expect(stamped[LATCH]).toBe(true);
  });

  it("leaves the latch absent (never false) when off and never previously enabled", () => {
    const stamped = stampSnapshotStoreOrgEverEnabled(null, { [MODE]: "off" });
    expect(LATCH in stamped).toBe(false);
  });

  it("leaves the latch absent when the dial is omitted and never previously enabled", () => {
    const stamped = stampSnapshotStoreOrgEverEnabled(null, { someOther: "flag" });
    expect(LATCH in stamped).toBe(false);
  });

  it("is stripped from an operator-supplied org save payload", () => {
    expect(withoutOrgForbiddenSnapshotKeys({ [LATCH]: false, [MODE]: "off" })).toEqual({
      [MODE]: "off",
    });
  });
});

describe("clearedOrgFlagsPreservingLatch (clear-all keeps the one-way latch)", () => {
  it("preserves the latch when the org was ever enabled", () => {
    expect(clearedOrgFlagsPreservingLatch({ [LATCH]: true, [MODE]: "off" })).toEqual({
      [LATCH]: true,
    });
  });

  it("wipes to null when the org never latched", () => {
    expect(clearedOrgFlagsPreservingLatch({ [MODE]: "off" })).toBeNull();
    expect(clearedOrgFlagsPreservingLatch({})).toBeNull();
    expect(clearedOrgFlagsPreservingLatch(null)).toBeNull();
  });

  it("never treats a false latch as latched", () => {
    expect(clearedOrgFlagsPreservingLatch({ [LATCH]: false })).toBeNull();
  });
});

describe("orgEverEnabled reader", () => {
  function clientReturning(flags: unknown) {
    return {
      organization: { findFirst: () => Promise.resolve({ featureFlags: flags }) },
    } as never;
  }

  it("returns undefined for an unknown organisation (cache miss)", () => {
    const source = createOrgModeSource({
      primary: clientReturning({}),
      replica: clientReturning({}),
    });
    expect(source.orgEverEnabled("org_unknown")).toBeUndefined();
  });

  it("returns the cached true latch", async () => {
    const source = createOrgModeSource({
      primary: clientReturning({}),
      replica: clientReturning({ [LATCH]: true }),
    });
    await source.warm("org_1");
    expect(source.orgEverEnabled("org_1")).toBe(true);
  });

  it("returns the cached false latch, distinct from absent", async () => {
    const source = createOrgModeSource({
      primary: clientReturning({}),
      replica: clientReturning({ [LATCH]: false }),
    });
    await source.warm("org_1");
    expect(source.orgEverEnabled("org_1")).toBe(false);
  });

  it("returns undefined when the cached flags omit the latch (not false)", async () => {
    const source = createOrgModeSource({
      primary: clientReturning({}),
      replica: clientReturning({ [MODE]: "dual-write" }),
    });
    await source.warm("org_1");
    // The dial is cached, but the latch key is absent, so the reader must not report false.
    expect(source.get("org_1")).toBe("dual-write");
    expect(source.orgEverEnabled("org_1")).toBeUndefined();
  });
});
