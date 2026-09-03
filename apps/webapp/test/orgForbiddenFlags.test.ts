import { describe, expect, it } from "vitest";
import { FEATURE_FLAG, ORG_FORBIDDEN_FLAGS, stripOrgForbiddenFlags } from "~/v3/featureFlags";

describe("stripOrgForbiddenFlags", () => {
  it("forbids the run-store retry flag as a per-org override", () => {
    expect(ORG_FORBIDDEN_FLAGS).toContain(FEATURE_FLAG.runStoreInfraRetryEnabled);
    const out = stripOrgForbiddenFlags({
      [FEATURE_FLAG.runStoreInfraRetryEnabled]: true,
      [FEATURE_FLAG.hasAiAccess]: true,
    });
    expect(out[FEATURE_FLAG.runStoreInfraRetryEnabled]).toBeUndefined();
  });

  it("leaves every other override intact (established org overrides survive unrelated saves)", () => {
    const overrides = {
      [FEATURE_FLAG.hasAiAccess]: true,
      [FEATURE_FLAG.hasComputeAccess]: false,
      [FEATURE_FLAG.taskEventRepository]: "clickhouse",
    };
    const out = stripOrgForbiddenFlags({
      ...overrides,
      [FEATURE_FLAG.runStoreInfraRetryEnabled]: true,
    });
    expect(out).toEqual(overrides);
  });

  it("does not mutate its input", () => {
    const input = {
      [FEATURE_FLAG.runStoreInfraRetryEnabled]: true,
      [FEATURE_FLAG.hasAiAccess]: true,
    };
    stripOrgForbiddenFlags(input);
    expect(input[FEATURE_FLAG.runStoreInfraRetryEnabled]).toBe(true);
  });
});
