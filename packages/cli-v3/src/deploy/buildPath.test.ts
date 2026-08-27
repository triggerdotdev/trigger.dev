import { describe, expect, it } from "vitest";
import { applyBuildPathOptions, nativeOnlyFlagError } from "./buildPath.js";

const none = { nativeBuildServer: false, localBundle: false, detach: false, dryRun: false };
const native = { ...none, nativeBuildServer: true };

describe("nativeOnlyFlagError", () => {
  it("requires --native-build for --local-bundle and --detach", () => {
    expect(nativeOnlyFlagError({ ...none, localBundle: true })).toBe(
      "--local-bundle requires --native-build."
    );
    expect(nativeOnlyFlagError({ ...none, detach: true })).toBe(
      "--detach requires --native-build."
    );
  });

  it("is satisfied by --native-build and by having neither flag", () => {
    expect(nativeOnlyFlagError({ ...native, localBundle: true, detach: true })).toBeUndefined();
    expect(nativeOnlyFlagError(none)).toBeUndefined();
  });
});

describe("applyBuildPathOptions", () => {
  it("passes the resolved path through without modifiers", () => {
    expect(applyBuildPathOptions("depot", none)).toBe("depot");
    expect(applyBuildPathOptions("native", none)).toBe("native");
    expect(applyBuildPathOptions("native_local_bundle", none)).toBe("native_local_bundle");
  });

  it("upgrades a native path to the local bundle variant with --local-bundle", () => {
    expect(applyBuildPathOptions("native", { ...native, localBundle: true })).toBe(
      "native_local_bundle"
    );
  });

  it("keeps --detach on the native paths", () => {
    expect(applyBuildPathOptions("native", { ...native, detach: true })).toBe("native");
    expect(applyBuildPathOptions("native_local_bundle", { ...native, detach: true })).toBe(
      "native_local_bundle"
    );
  });

  it("moves a native dry run onto the Depot path, however native was chosen", () => {
    expect(applyBuildPathOptions("native", { ...none, dryRun: true })).toBe("depot");
    expect(applyBuildPathOptions("native", { ...native, dryRun: true })).toBe("depot");
  });

  it("lets a local-bundle dry run stay on the local bundle path", () => {
    expect(applyBuildPathOptions("native", { ...native, localBundle: true, dryRun: true })).toBe(
      "native_local_bundle"
    );
    expect(applyBuildPathOptions("native_local_bundle", { ...none, dryRun: true })).toBe(
      "native_local_bundle"
    );
  });
});
