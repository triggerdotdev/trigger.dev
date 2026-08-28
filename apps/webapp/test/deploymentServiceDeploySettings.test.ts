import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isBillingConfigured: vi.fn<() => boolean>(),
  current: vi.fn<() => Record<string, unknown> | undefined>(),
  flags: vi.fn<() => Promise<Record<string, unknown>>>(),
}));

vi.mock("~/services/platform.v3.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isBillingConfigured: mocks.isBillingConfigured,
}));
vi.mock("~/v3/globalFlagsRegistry.server", () => ({
  globalFlagsRegistry: { current: mocks.current },
}));
vi.mock("~/v3/featureFlags.server", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  flags: mocks.flags,
}));

import { DeploymentService } from "~/v3/services/deployment.server";

type EnvType = "DEVELOPMENT" | "PREVIEW" | "STAGING" | "PRODUCTION";
type EnvSlug = "dev" | "staging" | "prod" | "preview";

const SLUG: Record<EnvType, EnvSlug> = {
  DEVELOPMENT: "dev",
  STAGING: "staging",
  PRODUCTION: "prod",
  PREVIEW: "preview",
};

function resolve(
  type: EnvType,
  orgFeatureFlags: unknown = {},
  target = { projectRef: "proj_ref", envSlug: SLUG[type] }
) {
  return new DeploymentService().getDeploySettings(
    {
      type,
      project: { externalRef: "proj_ref" },
      organization: { featureFlags: orgFeatureFlags },
    } as any,
    target
  );
}

async function path(type: EnvType, orgFeatureFlags: unknown = {}) {
  const result = await resolve(type, orgFeatureFlags);
  if (result.isErr()) throw result.error.cause;
  return [result.value.buildPath, result.value.buildPathSource];
}

describe("DeploymentService.getDeploySettings", () => {
  beforeEach(() => {
    mocks.isBillingConfigured.mockReset().mockReturnValue(true);
    mocks.current.mockReset().mockReturnValue({});
    mocks.flags.mockReset().mockResolvedValue({});
  });

  it("rejects a target that is not the key's project or environment type", async () => {
    mocks.current.mockReturnValue({ deployBuildPath: "native" });
    for (const target of [
      { projectRef: "proj_other", envSlug: "prod" as const },
      { projectRef: "proj_ref", envSlug: "staging" as const },
      { projectRef: "proj_ref", envSlug: "preview" as const },
    ]) {
      const result = await resolve("PRODUCTION", {}, target);
      expect(result.isErr() && result.error).toEqual({ type: "environment_mismatch" });
    }
    expect(mocks.flags).not.toHaveBeenCalled();
  });

  it("accepts every environment type on its own slug", async () => {
    for (const type of ["DEVELOPMENT", "PREVIEW", "STAGING", "PRODUCTION"] as const) {
      expect(await path(type)).toEqual(["depot", "default"]);
    }
  });

  it("is depot when the native build server is unavailable, whatever the flags say", async () => {
    mocks.isBillingConfigured.mockReturnValue(false);
    mocks.current.mockReturnValue({ deployBuildPath: "native" });
    expect(await path("PRODUCTION", { deployBuildPath: "native" })).toEqual([
      "depot",
      "unavailable",
    ]);
  });

  it("defaults to depot when nothing is set", async () => {
    expect(await path("PRODUCTION")).toEqual(["depot", "default"]);
  });

  it("applies the plain global flag to every environment type", async () => {
    mocks.current.mockReturnValue({ deployBuildPath: "native" });
    for (const type of ["DEVELOPMENT", "PREVIEW", "STAGING", "PRODUCTION"] as const) {
      expect(await path(type)).toEqual(["native", "global"]);
    }
  });

  it("prefers the global env-type flag over the plain global flag", async () => {
    mocks.current.mockReturnValue({
      deployBuildPath: "native",
      deployBuildPathProduction: "depot",
    });
    expect(await path("PRODUCTION")).toEqual(["depot", "global_environment"]);
    expect(await path("STAGING")).toEqual(["native", "global"]);
  });

  it("lets the org plain flag beat every global flag", async () => {
    mocks.current.mockReturnValue({
      deployBuildPath: "native",
      deployBuildPathProduction: "native",
    });
    expect(await path("PRODUCTION", { deployBuildPath: "depot" })).toEqual([
      "depot",
      "organization",
    ]);

    mocks.current.mockReturnValue({ deployBuildPath: "depot" });
    expect(await path("PRODUCTION", { deployBuildPath: "native" })).toEqual([
      "native",
      "organization",
    ]);
  });

  it("prefers the org env-type flag over the org plain flag", async () => {
    const org = { deployBuildPath: "native", deployBuildPathPreview: "native_local_bundle" };
    expect(await path("PREVIEW", org)).toEqual(["native_local_bundle", "organization_environment"]);
    expect(await path("PRODUCTION", org)).toEqual(["native", "organization"]);
  });

  it("never lets another environment type's key leak", async () => {
    mocks.current.mockReturnValue({ deployBuildPathStaging: "native" });
    expect(await path("PRODUCTION", { deployBuildPathPreview: "native" })).toEqual([
      "depot",
      "default",
    ]);
    expect(await path("DEVELOPMENT", { deployBuildPathProduction: "native" })).toEqual([
      "depot",
      "default",
    ]);
  });

  it("skips values the schema rejects instead of treating them as depot", async () => {
    mocks.current.mockReturnValue({ deployBuildPath: "native" });
    expect(await path("PRODUCTION", { deployBuildPathProduction: "bogus" })).toEqual([
      "native",
      "global",
    ]);
    expect(
      await path("PRODUCTION", { deployBuildPathProduction: null, deployBuildPath: 1 })
    ).toEqual(["native", "global"]);
  });

  it("tolerates a malformed org flag blob", async () => {
    mocks.current.mockReturnValue({ deployBuildPath: "native" });
    for (const blob of [null, undefined, "native", 42, ["native"]]) {
      expect(await path("PRODUCTION", blob)).toEqual(["native", "global"]);
    }
  });

  it("reads the registry snapshot without calling flags()", async () => {
    mocks.current.mockReturnValue({ deployBuildPath: "native" });
    await path("PRODUCTION");
    expect(mocks.flags).not.toHaveBeenCalled();
  });

  it("falls back to flags() when the registry is cold", async () => {
    mocks.current.mockReturnValue(undefined);
    mocks.flags.mockResolvedValue({ deployBuildPath: "native" });
    expect(await path("PRODUCTION")).toEqual(["native", "global"]);
    expect(mocks.flags).toHaveBeenCalledTimes(1);
  });

  it("returns an error when the global flags cannot be loaded", async () => {
    mocks.current.mockReturnValue(undefined);
    mocks.flags.mockRejectedValue(new Error("db down"));
    const result = await resolve("PRODUCTION");
    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error).toMatchObject({ type: "failed_to_load_global_flags" });
  });
});
