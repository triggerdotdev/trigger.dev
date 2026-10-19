import { describe, expect, it } from "vitest";
import { workerQueueForBirth } from "~/runEngine/concerns/workerQueueAssignment.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";

const assignment = {
  workerQueue: "us-east-1-next",
  region: "us-east-1",
  envType: "PRODUCTION",
  orgFeatureFlags: null,
  v2Enabled: true,
  splitEnabled: true,
  workerGroups: [{ masterQueue: "us-east-1-next", workloadType: "MICROVM" as const }],
  rootTriggerSource: "api",
};

describe("workerQueueForBirth", () => {
  it.each([false, true])(
    "keeps legacy assignment when v2 is disabled (split=%s)",
    (splitEnabled) => {
      expect(
        workerQueueForBirth({
          ...assignment,
          workerQueue: "my workers",
          region: undefined,
          workerGroups: [{ masterQueue: "my workers", workloadType: "CONTAINER" }],
          v2Enabled: false,
          splitEnabled,
          rootTriggerSource: "schedule",
          orgFeatureFlags: {
            workerQueueV2Enabled: true,
            workerQueueScheduledSplitEnabled: true,
          },
        })
      ).toBe(splitEnabled ? "my workers:scheduled" : "my workers");
    }
  );

  it("keeps scheduled runs on the ondemand v2 queue when the split is disabled", () => {
    expect(
      workerQueueForBirth({ ...assignment, splitEnabled: false, rootTriggerSource: "schedule" })
    ).toBe("us-east-1:v2:ondemand:fresh:compute:stable");
  });

  it("keeps legacy routing when the selected queue is absent from a loaded registry", () => {
    const input = {
      ...assignment,
      region: assignment.workerQueue,
      workerGroups: [{ masterQueue: "us-west-2", workloadType: "CONTAINER" as const }],
    };
    expect(workerQueueForBirth(input)).toBe("us-east-1-next");
    expect(workerQueueForBirth({ ...input, rootTriggerSource: "schedule" })).toBe(
      "us-east-1-next:scheduled"
    );
  });

  it("uses the geographic region and selected runtime for deployed runs", () => {
    expect(workerQueueForBirth(assignment)).toBe("us-east-1:v2:ondemand:fresh:compute:stable");
    expect(
      workerQueueForBirth({
        ...assignment,
        workerGroups: [{ masterQueue: "us-east-1-next", workloadType: "CONTAINER" }],
      })
    ).toBe("us-east-1:v2:ondemand:fresh:container:stable");
  });

  it("honors channel and explicit shared-runtime assignment", () => {
    expect(
      workerQueueForBirth({
        ...assignment,
        orgFeatureFlags: {
          [FEATURE_FLAG.workerQueueCompatibility]: "any",
          [FEATURE_FLAG.workerQueueChannel]: "canary",
        },
        rootTriggerSource: "schedule",
      })
    ).toBe("us-east-1:v2:scheduled:fresh:any:canary");
  });

  it("ignores obsolete opt-outs for v2 and scheduled assignment", () => {
    expect(
      workerQueueForBirth({
        ...assignment,
        orgFeatureFlags: {
          workerQueueV2Enabled: false,
          workerQueueScheduledSplitEnabled: false,
        },
        rootTriggerSource: "schedule",
      })
    ).toBe("us-east-1:v2:scheduled:fresh:compute:stable");
  });

  it.each(["api", "schedule"])(
    "leaves development on the base legacy queue for %s",
    (rootTriggerSource) => {
      expect(
        workerQueueForBirth({
          ...assignment,
          envType: "DEVELOPMENT",
          rootTriggerSource,
        })
      ).toBe("us-east-1-next");
    }
  );
});
