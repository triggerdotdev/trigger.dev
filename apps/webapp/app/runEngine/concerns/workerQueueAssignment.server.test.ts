import { describe, expect, it } from "vitest";
import { workerQueueForBirth } from "~/runEngine/concerns/workerQueueAssignment.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";

const assignment = {
  workerQueue: "us-east-1-next",
  region: "us-east-1",
  envType: "PRODUCTION",
  orgFeatureFlags: null,
  globalDefault: false,
  workerGroups: [{ masterQueue: "us-east-1-next", workloadType: "MICROVM" as const }],
  rootTriggerSource: "api",
  splitEnabled: true,
};

describe("workerQueueForBirth", () => {
  it("keeps legacy assignment and scheduled lineage when v2 is off", () => {
    expect(workerQueueForBirth(assignment)).toBe("us-east-1-next");
    expect(workerQueueForBirth({ ...assignment, rootTriggerSource: "schedule" })).toBe(
      "us-east-1-next:scheduled"
    );
  });

  it("keeps legacy routing when the selected queue is absent from a loaded registry", () => {
    const input = {
      ...assignment,
      region: assignment.workerQueue,
      globalDefault: true,
      workerGroups: [{ masterQueue: "us-west-2", workloadType: "CONTAINER" as const }],
    };
    expect(workerQueueForBirth(input)).toBe("us-east-1-next");
    expect(workerQueueForBirth({ ...input, rootTriggerSource: "schedule" })).toBe(
      "us-east-1-next:scheduled"
    );
  });

  it("uses the geographic region and selected runtime when v2 is enabled", () => {
    expect(workerQueueForBirth({ ...assignment, globalDefault: true })).toBe(
      "us-east-1:v2:ondemand:fresh:compute:stable"
    );
    expect(
      workerQueueForBirth({
        ...assignment,
        globalDefault: true,
        workerGroups: [{ masterQueue: "us-east-1-next", workloadType: "CONTAINER" }],
      })
    ).toBe("us-east-1:v2:ondemand:fresh:container:stable");
  });

  it("honors org opt-in, channel and explicit shared-runtime assignment", () => {
    expect(
      workerQueueForBirth({
        ...assignment,
        orgFeatureFlags: {
          [FEATURE_FLAG.workerQueueV2Enabled]: true,
          [FEATURE_FLAG.workerQueueCompatibility]: "any",
          [FEATURE_FLAG.workerQueueChannel]: "canary",
        },
        rootTriggerSource: "schedule",
      })
    ).toBe("us-east-1:v2:scheduled:fresh:any:canary");
  });

  it("honors org opt-out even when the global default is enabled", () => {
    expect(
      workerQueueForBirth({
        ...assignment,
        globalDefault: true,
        orgFeatureFlags: { [FEATURE_FLAG.workerQueueV2Enabled]: false },
      })
    ).toBe("us-east-1-next");
  });

  it("leaves development on the legacy path even with an org opt-in", () => {
    expect(
      workerQueueForBirth({
        ...assignment,
        envType: "DEVELOPMENT",
        splitEnabled: false,
        globalDefault: true,
        orgFeatureFlags: { [FEATURE_FLAG.workerQueueV2Enabled]: true },
      })
    ).toBe("us-east-1-next");
  });
});
