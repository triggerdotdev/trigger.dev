import { describe, expect, it } from "vitest";
import {
  allowsAnyCompat,
  resolveComputeMigration,
} from "~/runEngine/concerns/computeMigration.server";
import {
  environmentWorkerQueueOverride,
  workerQueueForBirth,
} from "~/runEngine/concerns/workerQueueAssignment.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";

const assignment = {
  workerQueue: "us-east-1-next",
  region: "us-east-1",
  envType: "PRODUCTION",
  orgFeatureFlags: null,
  environmentOverride: {},
  v2Enabled: true,
  splitEnabled: true,
  workerGroups: [{ masterQueue: "us-east-1-next", workloadType: "MICROVM" as const }],
  rootTriggerSource: "api",
  anyCompatAllowed: true,
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

describe("per-environment worker queue overrides", () => {
  const environmentId = "cm0000000000000000000stg1";
  const containerAssignment = {
    ...assignment,
    workerGroups: [{ masterQueue: "us-east-1-next", workloadType: "CONTAINER" as const }],
  };

  function birth(orgFeatureFlags: Record<string, unknown>, environmentType = "STAGING") {
    return workerQueueForBirth({
      ...containerAssignment,
      envType: environmentType,
      orgFeatureFlags,
      environmentOverride: environmentWorkerQueueOverride({
        orgFeatureFlags,
        environmentId,
        environmentType,
      }),
    });
  }

  it("resolves the environment id, then the environment type, then the org flag, then the default", () => {
    const org = {
      [FEATURE_FLAG.workerQueueCompatibility]: "any",
      [FEATURE_FLAG.workerQueueChannel]: "canary",
    };
    const byType = { STAGING: { compat: "compute", channel: "stable" } };
    const byId = { [environmentId]: { compat: "container", channel: "canary" } };

    expect(birth({})).toBe("us-east-1:v2:ondemand:fresh:container:stable");
    expect(birth(org)).toBe("us-east-1:v2:ondemand:fresh:any:canary");
    expect(birth({ ...org, [FEATURE_FLAG.workerQueueEnvironmentOverrides]: byType })).toBe(
      "us-east-1:v2:ondemand:fresh:compute:stable"
    );
    expect(
      birth({ ...org, [FEATURE_FLAG.workerQueueEnvironmentOverrides]: { ...byType, ...byId } })
    ).toBe("us-east-1:v2:ondemand:fresh:container:canary");
  });

  it("resolves compat and channel independently", () => {
    expect(
      birth({
        [FEATURE_FLAG.workerQueueChannel]: "canary",
        [FEATURE_FLAG.workerQueueEnvironmentOverrides]: {
          STAGING: { compat: "compute" },
          [environmentId]: { channel: "stable" },
        },
      })
    ).toBe("us-east-1:v2:ondemand:fresh:compute:stable");
    expect(
      birth({
        [FEATURE_FLAG.workerQueueCompatibility]: "any",
        [FEATURE_FLAG.workerQueueEnvironmentOverrides]: { STAGING: { channel: "canary" } },
      })
    ).toBe("us-east-1:v2:ondemand:fresh:any:canary");
  });

  it("leaves other environment types on the org flags", () => {
    expect(
      birth(
        { [FEATURE_FLAG.workerQueueEnvironmentOverrides]: { STAGING: { compat: "compute" } } },
        "PRODUCTION"
      )
    ).toBe("us-east-1:v2:ondemand:fresh:container:stable");
  });

  it("ignores overrides for development environments", () => {
    const orgFeatureFlags = {
      [FEATURE_FLAG.workerQueueEnvironmentOverrides]: {
        DEVELOPMENT: { compat: "compute" },
        [environmentId]: { compat: "compute" },
      },
    };
    expect(
      environmentWorkerQueueOverride({
        orgFeatureFlags,
        environmentId,
        environmentType: "DEVELOPMENT",
      })
    ).toEqual({});
    expect(birth(orgFeatureFlags, "DEVELOPMENT")).toBe("us-east-1-next");
  });

  it("resolves nothing when the org has no flags", () => {
    for (const orgFeatureFlags of [null, undefined]) {
      expect(
        environmentWorkerQueueOverride({
          orgFeatureFlags,
          environmentId,
          environmentType: "STAGING",
        })
      ).toEqual({});
    }
  });

  it("falls through an entry the schema rejects", () => {
    expect(
      birth({
        [FEATURE_FLAG.workerQueueChannel]: "canary",
        [FEATURE_FLAG.workerQueueEnvironmentOverrides]: {
          STAGING: { compat: "compute" },
          [environmentId]: { compat: "gpu", channel: "canary" },
        },
      })
    ).toBe("us-east-1:v2:ondemand:fresh:compute:canary");
    expect(birth({ [FEATURE_FLAG.workerQueueEnvironmentOverrides]: ["STAGING"] })).toBe(
      "us-east-1:v2:ondemand:fresh:container:stable"
    );
  });

  describe("composed with the compute migration, as at trigger time", () => {
    const workerGroups = [
      { masterQueue: "us-east-1", workloadType: "CONTAINER" as const },
      { masterQueue: "us-east-1-next", workloadType: "MICROVM" as const },
    ];
    const backing = { workerQueue: "us-east-1-next", enableFastPath: true };

    function trigger({
      orgFeatureFlags,
      environmentType = "STAGING",
      v2Enabled = true,
      migrationEnabled = false,
      templateKey = "a".repeat(64),
    }: {
      orgFeatureFlags: Record<string, unknown>;
      environmentType?: string;
      v2Enabled?: boolean;
      migrationEnabled?: boolean;
      templateKey?: string | null;
    }) {
      const environmentOverride = environmentWorkerQueueOverride({
        orgFeatureFlags,
        environmentId,
        environmentType,
      });
      const decision = {
        planType: "free",
        orgId: "org_x",
        orgFeatureFlags,
        flags: { computeMigrationEnabled: migrationEnabled, computeMigrationFreePercentage: 100 },
        templateKey,
      };
      const migrated = resolveComputeMigration({
        ...decision,
        baseWorkerQueue: "us-east-1",
        baseEnableFastPath: false,
        region: "us-east-1",
        backing,
        envType: environmentType,
        environmentCompat: environmentOverride.compat,
      });
      const workerQueue = workerQueueForBirth({
        workerQueue: migrated.workerQueue!,
        region: migrated.region,
        envType: environmentType,
        orgFeatureFlags,
        environmentOverride,
        v2Enabled,
        splitEnabled: true,
        workerGroups,
        rootTriggerSource: "api",
        templateFallback: migrated.templateFallback,
        anyCompatAllowed: allowsAnyCompat(decision),
      });
      return { workerQueue, enableFastPath: migrated.enableFastPath };
    }

    const stagingOnCompute = {
      [FEATURE_FLAG.workerQueueEnvironmentOverrides]: { STAGING: { compat: "compute" } },
    };

    it("births a compute environment on the backing group while production stays on containers", () => {
      expect(trigger({ orgFeatureFlags: stagingOnCompute })).toEqual({
        workerQueue: "us-east-1:v2:ondemand:fresh:compute:stable",
        enableFastPath: true,
      });
      expect(trigger({ orgFeatureFlags: stagingOnCompute, environmentType: "PRODUCTION" })).toEqual(
        {
          workerQueue: "us-east-1:v2:ondemand:fresh:container:stable",
          enableFastPath: false,
        }
      );
    });

    it("uses the backing group's legacy queue when v2 is off", () => {
      expect(trigger({ orgFeatureFlags: stagingOnCompute, v2Enabled: false })).toEqual({
        workerQueue: "us-east-1-next",
        enableFastPath: true,
      });
    });

    it("keeps a container environment of a migrated org off the backing group", () => {
      const stagingOnContainers = {
        [FEATURE_FLAG.workerQueueEnvironmentOverrides]: { STAGING: { compat: "container" } },
      };
      expect(trigger({ orgFeatureFlags: stagingOnContainers, migrationEnabled: true })).toEqual({
        workerQueue: "us-east-1:v2:ondemand:fresh:container:stable",
        enableFastPath: false,
      });
      expect(
        trigger({
          orgFeatureFlags: stagingOnContainers,
          migrationEnabled: true,
          environmentType: "PRODUCTION",
        })
      ).toEqual({
        workerQueue: "us-east-1:v2:ondemand:fresh:compute:stable",
        enableFastPath: true,
      });
    });

    it("does not move off a base queue that is already the compute group", () => {
      const environmentOverride = { compat: "container" as const };
      const migrated = resolveComputeMigration({
        baseWorkerQueue: "us-east-1-next",
        baseEnableFastPath: true,
        region: "us-east-1",
        backing: undefined,
        planType: "free",
        orgId: "org_x",
        orgFeatureFlags: {},
        flags: undefined,
        envType: "STAGING",
        environmentCompat: environmentOverride.compat,
        templateKey: "a".repeat(64),
      });
      expect(migrated.workerQueue).toBe("us-east-1-next");
      const birth = (v2Enabled: boolean) =>
        workerQueueForBirth({
          workerQueue: migrated.workerQueue!,
          region: migrated.region,
          envType: "STAGING",
          orgFeatureFlags: {},
          environmentOverride,
          v2Enabled,
          splitEnabled: false,
          workerGroups,
          rootTriggerSource: "api",
          anyCompatAllowed: true,
        });
      expect(birth(true)).toBe("us-east-1:v2:ondemand:fresh:container:stable");
      expect(birth(false)).toBe("us-east-1-next");
    });

    it("stamps compute on a region without a compute backing group", () => {
      const environmentOverride = { compat: "compute" as const };
      const migrated = resolveComputeMigration({
        baseWorkerQueue: "eu-central-1",
        baseEnableFastPath: false,
        region: "eu-central-1",
        backing: undefined,
        planType: "free",
        orgId: "org_x",
        orgFeatureFlags: {},
        flags: undefined,
        envType: "STAGING",
        environmentCompat: environmentOverride.compat,
        templateKey: "a".repeat(64),
      });
      expect(
        workerQueueForBirth({
          workerQueue: migrated.workerQueue!,
          region: migrated.region,
          envType: "STAGING",
          orgFeatureFlags: {},
          environmentOverride,
          v2Enabled: true,
          splitEnabled: false,
          workerGroups: [{ masterQueue: "eu-central-1", workloadType: "CONTAINER" }],
          rootTriggerSource: "api",
          anyCompatAllowed: true,
        })
      ).toBe("eu-central-1:v2:ondemand:fresh:compute:stable");
    });

    const anyOrg = { [FEATURE_FLAG.workerQueueCompatibility]: "any" };
    const anyStaging = {
      [FEATURE_FLAG.workerQueueEnvironmentOverrides]: { STAGING: { compat: "any" } },
    };
    it.each([
      { migrationEnabled: false, templateKey: "a".repeat(64), compat: "container" },
      { migrationEnabled: false, templateKey: null, compat: "container" },
      { migrationEnabled: true, templateKey: null, compat: "container" },
      { migrationEnabled: true, templateKey: "a".repeat(64), compat: "any" },
    ])(
      "gives the any lane only to a migrated org's keyed deployment (migrated=$migrationEnabled, key=$templateKey)",
      ({ migrationEnabled, templateKey, compat }) => {
        for (const orgFeatureFlags of [anyOrg, anyStaging]) {
          expect(trigger({ orgFeatureFlags, migrationEnabled, templateKey }).workerQueue).toBe(
            `us-east-1:v2:ondemand:fresh:${compat}:stable`
          );
        }
      }
    );

    it("puts a migrated org's keyless any-compat canary run on the stable container channel", () => {
      const canaryOrg = { [FEATURE_FLAG.workerQueueChannel]: "canary" };
      const canaryStaging = {
        [FEATURE_FLAG.workerQueueEnvironmentOverrides]: { STAGING: { channel: "canary" } },
      };
      const anyCanaryStaging = {
        [FEATURE_FLAG.workerQueueEnvironmentOverrides]: {
          STAGING: { compat: "any", channel: "canary" },
        },
      };
      for (const orgFeatureFlags of [
        { ...anyOrg, ...canaryOrg },
        { ...anyStaging, ...canaryOrg },
        { ...anyOrg, ...canaryStaging },
        anyCanaryStaging,
      ]) {
        expect(trigger({ orgFeatureFlags, migrationEnabled: true, templateKey: null })).toEqual({
          workerQueue: "us-east-1:v2:ondemand:fresh:container:stable",
          enableFastPath: false,
        });
      }
    });

    it("leaves a channel-only override to the org's migration decision", () => {
      const canaryStaging = {
        [FEATURE_FLAG.workerQueueEnvironmentOverrides]: { STAGING: { channel: "canary" } },
      };
      expect(trigger({ orgFeatureFlags: canaryStaging })).toEqual({
        workerQueue: "us-east-1:v2:ondemand:fresh:container:canary",
        enableFastPath: false,
      });
      expect(trigger({ orgFeatureFlags: canaryStaging, migrationEnabled: true })).toEqual({
        workerQueue: "us-east-1:v2:ondemand:fresh:compute:canary",
        enableFastPath: true,
      });
    });

    it("puts a migrated org's keyless run on the stable container channel", () => {
      const canaryStaging = {
        [FEATURE_FLAG.workerQueueEnvironmentOverrides]: { STAGING: { channel: "canary" } },
      };
      const canaryOrg = { [FEATURE_FLAG.workerQueueChannel]: "canary" };
      for (const orgFeatureFlags of [canaryStaging, canaryOrg]) {
        expect(trigger({ orgFeatureFlags, migrationEnabled: true, templateKey: null })).toEqual({
          workerQueue: "us-east-1:v2:ondemand:fresh:container:stable",
          enableFastPath: false,
        });
        // A run that is not migrated keeps its channel, keyless or not.
        expect(trigger({ orgFeatureFlags, templateKey: null })).toEqual({
          workerQueue: "us-east-1:v2:ondemand:fresh:container:canary",
          enableFastPath: false,
        });
      }
    });

    it("keeps an explicit compute compatibility for a keyless run, for the dequeue check", () => {
      expect(
        trigger({
          orgFeatureFlags: {
            [FEATURE_FLAG.workerQueueCompatibility]: "compute",
            [FEATURE_FLAG.workerQueueChannel]: "canary",
          },
          migrationEnabled: true,
          templateKey: null,
        })
      ).toEqual({
        workerQueue: "us-east-1:v2:ondemand:fresh:compute:canary",
        enableFastPath: false,
      });
    });
  });
});
