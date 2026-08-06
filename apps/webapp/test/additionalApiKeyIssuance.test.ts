import { describe, expect, it } from "vitest";
import { resolveAdditionalApiKeyIssuance } from "~/services/additionalApiKeyIssuance";
import { FEATURE_FLAG, FeatureFlagCatalog, ORG_LOCKED_FLAGS } from "~/v3/featureFlags";

describe("additional API key issuance controls", () => {
  it("registers strict rollout and system-wide flags", () => {
    expect(
      FeatureFlagCatalog[FEATURE_FLAG.additionalApiKeysEnabled].safeParse("false").success
    ).toBe(false);
    expect(
      FeatureFlagCatalog[FEATURE_FLAG.additionalApiKeyIssuanceEnabled].safeParse("false").success
    ).toBe(false);
    expect(ORG_LOCKED_FLAGS).not.toContain(FEATURE_FLAG.additionalApiKeysEnabled);
    expect(ORG_LOCKED_FLAGS).toContain(FEATURE_FLAG.additionalApiKeyIssuanceEnabled);
  });

  it("defaults to disabled", () => {
    expect(resolveAdditionalApiKeyIssuance(undefined, undefined)).toBe(false);
  });

  it("requires the system-wide issuance gate", () => {
    expect(
      resolveAdditionalApiKeyIssuance(
        { [FEATURE_FLAG.additionalApiKeyIssuanceEnabled]: false },
        { [FEATURE_FLAG.additionalApiKeysEnabled]: true }
      )
    ).toBe(false);
  });

  it("allows an organization override when issuance is enabled", () => {
    expect(
      resolveAdditionalApiKeyIssuance(
        { [FEATURE_FLAG.additionalApiKeyIssuanceEnabled]: true },
        { [FEATURE_FLAG.additionalApiKeysEnabled]: true }
      )
    ).toBe(true);
  });

  it("uses the global rollout value when the organization has no override", () => {
    expect(
      resolveAdditionalApiKeyIssuance(
        {
          [FEATURE_FLAG.additionalApiKeysEnabled]: true,
          [FEATURE_FLAG.additionalApiKeyIssuanceEnabled]: true,
        },
        undefined
      )
    ).toBe(true);
  });

  it("allows an organization to opt out of a global rollout", () => {
    expect(
      resolveAdditionalApiKeyIssuance(
        {
          [FEATURE_FLAG.additionalApiKeysEnabled]: true,
          [FEATURE_FLAG.additionalApiKeyIssuanceEnabled]: true,
        },
        { [FEATURE_FLAG.additionalApiKeysEnabled]: false }
      )
    ).toBe(false);
  });
});
