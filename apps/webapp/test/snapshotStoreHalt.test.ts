import { describe, expect, it } from "vitest";
import {
  FeatureFlagCatalog,
  ORG_LOCKED_FLAGS,
  withoutOrgForbiddenSnapshotKeys,
} from "~/v3/featureFlags";
import { buildSnapshotStoreHaltCheck } from "~/v3/snapshotStoreMode.server";

describe("the snapshot store halt check", () => {
  it("is not halted by default", () => {
    expect(buildSnapshotStoreHaltCheck({ flag: () => undefined, envHalt: false })()).toBe(false);
    expect(buildSnapshotStoreHaltCheck({ flag: () => false, envHalt: false })()).toBe(false);
  });

  it("halts on the flag, so an incident needs no deploy", () => {
    expect(buildSnapshotStoreHaltCheck({ flag: () => true, envHalt: false })()).toBe(true);
  });

  it("halts on the environment even when the flag registry is cold", () => {
    expect(buildSnapshotStoreHaltCheck({ flag: () => undefined, envHalt: true })()).toBe(true);
  });

  it("cannot be un-halted by the flag once the environment holds it", () => {
    expect(buildSnapshotStoreHaltCheck({ flag: () => false, envHalt: true })()).toBe(true);
  });
});

describe("the halt flag", () => {
  it("takes only a real boolean, so a stringified value cannot enable or disable it", () => {
    expect(FeatureFlagCatalog.snapshotStoreHalt.safeParse(true).success).toBe(true);
    expect(FeatureFlagCatalog.snapshotStoreHalt.safeParse(false).success).toBe(true);
    expect(FeatureFlagCatalog.snapshotStoreHalt.safeParse("true").success).toBe(false);
  });

  it("is deployment-wide only", () => {
    expect(ORG_LOCKED_FLAGS).toContain("snapshotStoreHalt");
    expect(
      withoutOrgForbiddenSnapshotKeys({ snapshotStoreHalt: true, runOpsMintKind: "cuid" })
    ).toEqual({ runOpsMintKind: "cuid" });
  });
});
