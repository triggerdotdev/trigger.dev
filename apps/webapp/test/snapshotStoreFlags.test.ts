import { describe, expect, it } from "vitest";
import {
  FeatureFlagCatalog,
  ORG_LOCKED_FLAGS,
  withoutOrgForbiddenSnapshotKeys,
} from "~/v3/featureFlags";

describe("snapshot store dial catalog", () => {
  it("accepts all four positions globally", () => {
    for (const value of ["off", "dual-write", "redis-read", "redis-only"]) {
      expect(FeatureFlagCatalog.snapshotStoreMode.safeParse(value).success).toBe(true);
    }
  });

  it("rejects an unknown position", () => {
    expect(FeatureFlagCatalog.snapshotStoreMode.safeParse("redis-write").success).toBe(false);
  });

  it("accepts all four positions per organisation, so an org can be soaked at a read position", () => {
    for (const value of ["off", "dual-write", "redis-read", "redis-only"]) {
      expect(FeatureFlagCatalog.snapshotStoreOrgMode.safeParse(value).success).toBe(true);
    }
    expect(FeatureFlagCatalog.snapshotStoreOrgMode.safeParse("redis-write").success).toBe(false);
  });

  it("lists the global dial as org-locked", () => {
    expect(ORG_LOCKED_FLAGS).toContain("snapshotStoreMode");
  });
});

describe("withoutOrgForbiddenSnapshotKeys", () => {
  it("removes the global dial and keeps everything else", () => {
    expect(
      withoutOrgForbiddenSnapshotKeys({
        snapshotStoreMode: "redis-only",
        snapshotStoreOrgMode: "dual-write",
        runOpsMintKind: "cuid",
      })
    ).toEqual({ snapshotStoreOrgMode: "dual-write", runOpsMintKind: "cuid" });
  });

  it("returns the same object when the dial is absent", () => {
    const input = { runOpsMintKind: "cuid" };
    expect(withoutOrgForbiddenSnapshotKeys(input)).toBe(input);
  });

  it("removes the dial even when it is the only key", () => {
    expect(withoutOrgForbiddenSnapshotKeys({ snapshotStoreMode: "dual-write" })).toEqual({});
  });
});
