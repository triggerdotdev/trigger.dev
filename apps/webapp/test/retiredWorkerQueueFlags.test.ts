import { expect, it } from "vitest";
import { FEATURE_FLAG, validatePartialFeatureFlags } from "~/v3/featureFlags";

it("ignores retired worker queue flags without discarding active flags", () => {
  const result = validatePartialFeatureFlags({
    workerQueueV2Enabled: false,
    workerQueueScheduledSplitEnabled: "obsolete",
    [FEATURE_FLAG.workerQueueChannel]: "canary",
  });

  expect(result.success).toBe(true);
  if (!result.success) throw result.error;
  expect(result.data).toEqual({ [FEATURE_FLAG.workerQueueChannel]: "canary" });
});
