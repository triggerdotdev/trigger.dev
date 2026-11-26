import { describe, expect, it } from "vitest";
import {
  availableOverrideScopes,
  incompleteOverrideScopes,
  orderedOverrideScopes,
  overrideScopeLabel,
  removeOverride,
  setOverrideField,
  type OverrideEnvironment,
} from "~/components/admin/workerQueueEnvironmentOverrides";
import {
  FEATURE_FLAG,
  getAllFlagControlTypes,
  GLOBAL_LOCKED_FLAGS,
  ORG_LOCKED_FLAGS,
  validateFeatureFlagValue,
  validatePartialFeatureFlags,
} from "~/v3/featureFlags";

const key = FEATURE_FLAG.workerQueueEnvironmentOverrides;
const environmentId = "cm0000000000000000000stg1";

describe("workerQueueEnvironmentOverrides flag", () => {
  it("accepts environment types and environment ids", () => {
    expect(
      validateFeatureFlagValue(key, {
        PRODUCTION: { compat: "container" },
        STAGING: { compat: "compute", channel: "canary" },
        PREVIEW: { channel: "stable" },
        [environmentId]: { compat: "any" },
      }).success
    ).toBe(true);
    expect(validateFeatureFlagValue(key, {}).success).toBe(true);
  });

  it("rejects keys that are not a routed environment type or an environment id", () => {
    for (const scope of ["DEVELOPMENT", "staging", "Production", "PROD", "", "env 1"]) {
      expect(validateFeatureFlagValue(key, { [scope]: { compat: "compute" } }).success).toBe(false);
    }
  });

  it("requires environment ids to be at least 20 lowercase alphanumerics", () => {
    expect(validateFeatureFlagValue(key, { ["c".repeat(20)]: { compat: "any" } }).success).toBe(
      true
    );
    expect(validateFeatureFlagValue(key, { ["c".repeat(19)]: { compat: "any" } }).success).toBe(
      false
    );
  });

  it("rejects entries outside the worker queue enums", () => {
    for (const entry of [
      {},
      { compat: "gpu" },
      { channel: "beta" },
      { compat: "compute", region: "us-east-1" },
      { compat: null },
      "compute",
      null,
    ]) {
      expect(validateFeatureFlagValue(key, { STAGING: entry }).success).toBe(false);
    }
  });

  it("rejects a value that is not a map", () => {
    for (const value of [null, [], "STAGING", JSON.stringify({ STAGING: { compat: "compute" } })]) {
      expect(validateFeatureFlagValue(key, value).success).toBe(false);
    }
  });

  it("goes through the admin flag write validation alongside the scalar flags", () => {
    const flags = {
      [FEATURE_FLAG.workerQueueCompatibility]: "container",
      [key]: { STAGING: { compat: "compute" } },
    };
    const result = validatePartialFeatureFlags(flags);
    expect(result.success).toBe(true);
    expect(result.data).toEqual(flags);

    expect(
      validatePartialFeatureFlags({ [key]: { DEVELOPMENT: { compat: "compute" } } }).success
    ).toBe(false);
  });

  it("is not offered a scalar control", () => {
    expect(getAllFlagControlTypes()[key]).toEqual({ type: "record" });
  });

  it("is editable per org and locked globally, like the scalar routing flags", () => {
    for (const flag of [
      FEATURE_FLAG.workerQueueCompatibility,
      FEATURE_FLAG.workerQueueChannel,
      key,
    ]) {
      expect(GLOBAL_LOCKED_FLAGS).toContain(flag);
      expect(ORG_LOCKED_FLAGS).not.toContain(flag);
    }
  });
});

describe("environment override table", () => {
  const environments: OverrideEnvironment[] = [
    {
      id: "cm0000000000000000000prd1",
      type: "PRODUCTION",
      branchName: null,
      projectName: "api",
    },
    { id: environmentId, type: "STAGING", branchName: null, projectName: "api" },
    {
      id: "cm0000000000000000000prv1",
      type: "PREVIEW",
      branchName: "feat-x",
      projectName: "web",
    },
  ];

  it("labels types, environments and ids it does not know", () => {
    expect(overrideScopeLabel("STAGING", environments)).toBe("All staging");
    expect(overrideScopeLabel(environmentId, environments)).toBe("api / Staging");
    expect(overrideScopeLabel("cm0000000000000000000prv1", environments)).toBe(
      "web / Preview (feat-x)"
    );
    expect(overrideScopeLabel("cm0000000000000000000gone", environments)).toBe(
      "Unknown environment (cm0000000000000000000gone)"
    );
  });

  it("orders types before environments and keeps unknown ids removable", () => {
    const overrides = {
      cm0000000000000000000gone: { compat: "compute" as const },
      [environmentId]: { channel: "canary" as const },
      STAGING: { compat: "compute" as const },
    };
    expect(orderedOverrideScopes(overrides, environments)).toEqual([
      "STAGING",
      environmentId,
      "cm0000000000000000000gone",
    ]);
    expect(availableOverrideScopes(overrides, environments)).toEqual([
      "PRODUCTION",
      "PREVIEW",
      "cm0000000000000000000prd1",
      "cm0000000000000000000prv1",
    ]);
  });

  it("edits one field of an entry and flags an entry left empty", () => {
    const overrides = { STAGING: { compat: "compute" as const, channel: "canary" as const } };

    const channelCleared = setOverrideField(overrides, "STAGING", "channel", undefined);
    expect(channelCleared).toEqual({ STAGING: { compat: "compute" } });
    expect(incompleteOverrideScopes(channelCleared)).toEqual([]);

    const emptied = setOverrideField(channelCleared, "STAGING", "compat", undefined);
    expect(incompleteOverrideScopes(emptied)).toEqual(["STAGING"]);
    expect(validateFeatureFlagValue(key, emptied).success).toBe(false);

    expect(setOverrideField(emptied, "STAGING", "compat", "container")).toEqual({
      STAGING: { compat: "container" },
    });
  });

  it("unsets the flag when the last entry is removed", () => {
    const overrides = {
      STAGING: { compat: "compute" as const },
      PREVIEW: { compat: "any" as const },
    };
    expect(removeOverride(overrides, "STAGING")).toEqual({ PREVIEW: { compat: "any" } });
    expect(removeOverride({ STAGING: { compat: "compute" } }, "STAGING")).toBeUndefined();
  });
});
