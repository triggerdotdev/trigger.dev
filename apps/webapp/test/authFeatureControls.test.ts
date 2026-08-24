import { describe, expect, it } from "vitest";
import { resolveAuthFeatureControls } from "~/services/authFeatureControls";
import { FEATURE_FLAG, FeatureFlagCatalog, ORG_LOCKED_FLAGS } from "~/v3/featureFlags";

describe("auth feature controls", () => {
  it("uses safe defaults for a cold or missing snapshot", () => {
    expect(resolveAuthFeatureControls(undefined)).toEqual({
      additionalApiKeyLookupEnabled: false,
    });
  });

  it("accepts only strict booleans and locks org overrides", () => {
    const flag = FEATURE_FLAG.additionalApiKeyLookupEnabled;
    expect(FeatureFlagCatalog[flag].safeParse(true).success).toBe(true);
    // Strict z.boolean(): the stringified "false" must not coerce to true.
    expect(FeatureFlagCatalog[flag].safeParse("false").success).toBe(false);
    expect(ORG_LOCKED_FLAGS).toContain(flag);
  });
});
