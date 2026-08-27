import { describe, expect, it } from "vitest";
import { applyBuildPathOptions } from "./buildPath.js";

const none = { localBundle: false, detach: false, dryRun: false };

describe("applyBuildPathOptions", () => {
  it("passes the resolved path through without modifiers", () => {
    expect(applyBuildPathOptions("depot", none)).toBe("depot");
    expect(applyBuildPathOptions("native", none)).toBe("native");
    expect(applyBuildPathOptions("native_local_bundle", none)).toBe("native_local_bundle");
  });

  it("upgrades a native path to the local bundle variant with --local-bundle", () => {
    expect(applyBuildPathOptions("native", { ...none, localBundle: true })).toBe(
      "native_local_bundle"
    );
  });

  it("rejects --local-bundle and --detach on Depot", () => {
    expect(() => applyBuildPathOptions("depot", { ...none, localBundle: true })).toThrow(
      /--local-bundle is only available with the native build server/
    );
    expect(() => applyBuildPathOptions("depot", { ...none, detach: true })).toThrow(
      /--detach is only available with the native build server/
    );
  });

  it("keeps --detach on the native paths", () => {
    expect(applyBuildPathOptions("native", { ...none, detach: true })).toBe("native");
    expect(applyBuildPathOptions("native_local_bundle", { ...none, detach: true })).toBe(
      "native_local_bundle"
    );
  });

  it("moves a native dry run onto the Depot path, however native was chosen", () => {
    expect(applyBuildPathOptions("native", { ...none, dryRun: true })).toBe("depot");
  });

  it("lets a local-bundle dry run stay on the local bundle path", () => {
    expect(applyBuildPathOptions("native", { ...none, localBundle: true, dryRun: true })).toBe(
      "native_local_bundle"
    );
    expect(applyBuildPathOptions("native_local_bundle", { ...none, dryRun: true })).toBe(
      "native_local_bundle"
    );
  });
});
