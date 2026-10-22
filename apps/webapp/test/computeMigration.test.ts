import { describe, it, expect } from "vitest";
import {
  isOrgMigrated,
  resolveComputeMigration,
} from "~/runEngine/concerns/computeMigration.server";

describe("isOrgMigrated", () => {
  const base = {
    planType: "free" as string | undefined,
    orgFeatureFlags: {} as Record<string, unknown>,
    flags: { computeMigrationEnabled: true, computeMigrationFreePercentage: 100 },
  };

  it("migrates a free org at 100%", () => {
    expect(isOrgMigrated({ ...base, orgId: "org_x" })).toBe(true);
  });
  it("does not migrate when globally disabled", () => {
    expect(
      isOrgMigrated({
        ...base,
        orgId: "org_x",
        flags: { computeMigrationEnabled: false, computeMigrationFreePercentage: 100 },
      })
    ).toBe(false);
  });
  it("per-org override false excludes even at 100%", () => {
    expect(
      isOrgMigrated({
        ...base,
        orgId: "org_x",
        orgFeatureFlags: { computeMigrationEnabled: false },
      })
    ).toBe(false);
  });
  it("per-org override true enrolls even when globally off", () => {
    expect(
      isOrgMigrated({
        ...base,
        orgId: "org_x",
        orgFeatureFlags: { computeMigrationEnabled: true },
        flags: { computeMigrationEnabled: false, computeMigrationFreePercentage: 0 },
      })
    ).toBe(true);
  });
  it("paid uses the paid dial", () => {
    expect(
      isOrgMigrated({
        planType: "paid",
        orgId: "org_x",
        orgFeatureFlags: {},
        flags: { computeMigrationEnabled: true, computeMigrationPaidPercentage: 100 },
      })
    ).toBe(true);
  });
  it("enterprise is never enrolled by percentage", () => {
    expect(
      isOrgMigrated({
        planType: "enterprise",
        orgId: "org_x",
        orgFeatureFlags: {},
        flags: {
          computeMigrationEnabled: true,
          computeMigrationFreePercentage: 100,
          computeMigrationPaidPercentage: 100,
        },
      })
    ).toBe(false);
  });
  it("undefined planType is not enrolled", () => {
    expect(
      isOrgMigrated({
        planType: undefined,
        orgId: "org_x",
        orgFeatureFlags: {},
        flags: { computeMigrationEnabled: true },
      })
    ).toBe(false);
  });
});

describe("resolveComputeMigration", () => {
  const enrolled = {
    planType: "free",
    orgFeatureFlags: {},
    flags: { computeMigrationEnabled: true, computeMigrationFreePercentage: 100 },
    envType: "PRODUCTION",
    baseEnableFastPath: false,
    region: "us-east-1",
    environmentCompat: undefined,
  };
  const backing = { workerQueue: "us-east-1-next", enableFastPath: true };

  it("swaps to the compute backing for an enrolled free org", () => {
    expect(
      resolveComputeMigration({
        ...enrolled,
        baseWorkerQueue: "us-east-1",
        orgId: "org_x",
        backing,
      })
    ).toEqual({ workerQueue: "us-east-1-next", region: "us-east-1", enableFastPath: true });
  });
  it("leaves the queue unchanged when there is no backing for the region (EU)", () => {
    expect(
      resolveComputeMigration({
        ...enrolled,
        baseWorkerQueue: "eu-central-1",
        region: "eu-central-1",
        orgId: "org_x",
        backing: undefined,
      })
    ).toEqual({ workerQueue: "eu-central-1", region: "eu-central-1", enableFastPath: false });
  });
  it("does not migrate DEVELOPMENT", () => {
    expect(
      resolveComputeMigration({
        ...enrolled,
        baseWorkerQueue: "us-east-1",
        orgId: "org_x",
        backing,
        envType: "DEVELOPMENT",
      })
    ).toEqual({ workerQueue: "us-east-1", region: "us-east-1", enableFastPath: false });
  });
  it("leaves a non-enrolled org untouched", () => {
    expect(
      resolveComputeMigration({
        ...enrolled,
        baseWorkerQueue: "us-east-1",
        orgId: "org_x",
        backing,
        flags: { computeMigrationEnabled: false },
      })
    ).toEqual({ workerQueue: "us-east-1", region: "us-east-1", enableFastPath: false });
  });
  it("undefined baseWorkerQueue passes through", () => {
    expect(
      resolveComputeMigration({
        ...enrolled,
        baseWorkerQueue: undefined,
        region: undefined,
        orgId: "org_x",
        backing,
      })
    ).toEqual({ workerQueue: undefined, region: undefined, enableFastPath: false });
  });

  describe("environment compat override", () => {
    const swapped = { workerQueue: "us-east-1-next", region: "us-east-1", enableFastPath: true };
    const base = { workerQueue: "us-east-1", region: "us-east-1", enableFastPath: false };
    const notEnrolled = { flags: { computeMigrationEnabled: false } };

    it("compute swaps an org the migration has not enrolled", () => {
      expect(
        resolveComputeMigration({
          ...enrolled,
          ...notEnrolled,
          baseWorkerQueue: "us-east-1",
          orgId: "org_x",
          backing,
          environmentCompat: "compute",
        })
      ).toEqual(swapped);
    });
    it("compute wins over the per-org opt-out for that environment", () => {
      expect(
        resolveComputeMigration({
          ...enrolled,
          baseWorkerQueue: "us-east-1",
          orgId: "org_x",
          orgFeatureFlags: { computeMigrationEnabled: false },
          backing,
          environmentCompat: "compute",
        })
      ).toEqual(swapped);
    });
    it("container keeps an enrolled org's environment on the base queue", () => {
      expect(
        resolveComputeMigration({
          ...enrolled,
          baseWorkerQueue: "us-east-1",
          orgId: "org_x",
          orgFeatureFlags: { computeMigrationEnabled: true },
          backing,
          environmentCompat: "container",
        })
      ).toEqual(base);
    });
    it("any follows the org's migration decision", () => {
      const input = {
        ...enrolled,
        baseWorkerQueue: "us-east-1",
        orgId: "org_x",
        backing,
        environmentCompat: "any" as const,
      };
      expect(resolveComputeMigration(input)).toEqual(swapped);
      expect(resolveComputeMigration({ ...input, ...notEnrolled })).toEqual(base);
    });
    it("compute without a backing group leaves the queue unchanged", () => {
      expect(
        resolveComputeMigration({
          ...enrolled,
          ...notEnrolled,
          baseWorkerQueue: "eu-central-1",
          region: "eu-central-1",
          orgId: "org_x",
          backing: undefined,
          environmentCompat: "compute",
        })
      ).toEqual({ workerQueue: "eu-central-1", region: "eu-central-1", enableFastPath: false });
    });
    it("does not swap DEVELOPMENT", () => {
      expect(
        resolveComputeMigration({
          ...enrolled,
          baseWorkerQueue: "us-east-1",
          orgId: "org_x",
          backing,
          envType: "DEVELOPMENT",
          environmentCompat: "compute",
        })
      ).toEqual(base);
    });
  });
});
