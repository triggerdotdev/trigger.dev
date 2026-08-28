import { describe, expect, it } from "vitest";
import {
  FeatureFlagCatalog,
  ORG_LOCKED_FLAGS,
  withoutOrgForbiddenSnapshotKeys,
} from "~/v3/featureFlags";
import { buildSnapshotStoreHaltCheck } from "~/v3/snapshotStoreMode.server";

describe("the snapshot store halt check", () => {
  it("is not halted by default", () => {
    expect(buildSnapshotStoreHaltCheck({ flag: () => undefined })()).toBe(false);
    expect(buildSnapshotStoreHaltCheck({ flag: () => false })()).toBe(false);
  });

  it("halts on the flag, so an incident needs no deploy", () => {
    expect(buildSnapshotStoreHaltCheck({ flag: () => true })()).toBe(true);
  });

  it("is the flag and nothing else, so it converges in one flag interval", () => {
    // The environment half is gone on purpose. It converged over a rolling deploy instead of a
    // flag interval, and during that window a halted process skips a transition while an unhalted
    // one asserts a head it cannot see, which forks once per process flip per run. A control whose
    // own convergence manufactures the divergence it exists to stop is not a control.
    expect(buildSnapshotStoreHaltCheck({ flag: () => false })()).toBe(false);
    expect(buildSnapshotStoreHaltCheck({ flag: () => true })()).toBe(true);
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
