import { describe, expect, it } from "vitest";
import { resolveDeployBuildPath, type ResolveDeployBuildPathInput } from "~/v3/deployBuildPath";

const base: ResolveDeployBuildPathInput = {
  environmentType: "PRODUCTION",
  orgFeatureFlags: {},
  globalFlags: {},
  projectBuildSettings: undefined,
  nativeBuildServerAvailable: true,
};

describe("resolveDeployBuildPath", () => {
  it("defaults to depot when nothing is set", () => {
    expect(resolveDeployBuildPath(base)).toEqual({ path: "depot", source: "default" });
  });

  it("uses the global flag for every environment type", () => {
    expect(resolveDeployBuildPath({ ...base, globalFlags: { deployBuildPath: "native" } })).toEqual(
      { path: "native", source: "global" }
    );
  });

  it("prefers the global env-type flag over the plain global flag", () => {
    const globalFlags = { deployBuildPath: "depot", deployBuildPathPreview: "native" };
    expect(resolveDeployBuildPath({ ...base, environmentType: "PREVIEW", globalFlags })).toEqual({
      path: "native",
      source: "global_environment",
    });
    expect(resolveDeployBuildPath({ ...base, environmentType: "STAGING", globalFlags })).toEqual({
      path: "depot",
      source: "global",
    });
  });

  it("lets an org override beat the global flags, in both directions", () => {
    expect(
      resolveDeployBuildPath({
        ...base,
        globalFlags: { deployBuildPathProduction: "native" },
        orgFeatureFlags: { deployBuildPath: "depot" },
      })
    ).toEqual({ path: "depot", source: "organization" });
    expect(
      resolveDeployBuildPath({
        ...base,
        orgFeatureFlags: { deployBuildPath: "native_local_bundle" },
      })
    ).toEqual({ path: "native_local_bundle", source: "organization" });
  });

  it("prefers the org env-type flag over the org plain flag", () => {
    expect(
      resolveDeployBuildPath({
        ...base,
        environmentType: "STAGING",
        orgFeatureFlags: { deployBuildPath: "native", deployBuildPathStaging: "depot" },
      })
    ).toEqual({ path: "depot", source: "organization_environment" });
  });

  it("ignores env-type flags for development environments", () => {
    expect(
      resolveDeployBuildPath({
        ...base,
        environmentType: "DEVELOPMENT",
        orgFeatureFlags: { deployBuildPathProduction: "native" },
        globalFlags: { deployBuildPath: "native" },
      })
    ).toEqual({ path: "native", source: "global" });
  });

  it("skips values the catalog rejects instead of treating them as depot", () => {
    expect(
      resolveDeployBuildPath({
        ...base,
        orgFeatureFlags: { deployBuildPath: "nope" },
        globalFlags: { deployBuildPath: "native" },
      })
    ).toEqual({ path: "native", source: "global" });
  });

  it("tolerates a non-object org flag blob", () => {
    expect(resolveDeployBuildPath({ ...base, orgFeatureFlags: "garbage" })).toEqual({
      path: "depot",
      source: "default",
    });
  });

  it("honors the project opt-out over every flag", () => {
    expect(
      resolveDeployBuildPath({
        ...base,
        orgFeatureFlags: { deployBuildPath: "native" },
        globalFlags: { deployBuildPath: "native" },
        projectBuildSettings: { disableNativeBuildServer: true },
      })
    ).toEqual({ path: "depot", source: "project_opt_out" });
  });

  it("falls back to depot when the native build server is not available", () => {
    expect(
      resolveDeployBuildPath({
        ...base,
        orgFeatureFlags: { deployBuildPath: "native" },
        nativeBuildServerAvailable: false,
      })
    ).toEqual({ path: "depot", source: "unavailable" });
  });
});
