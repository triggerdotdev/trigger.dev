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
      isOrgMigrated({ ...base, orgId: "org_x", flags: { computeMigrationEnabled: false, computeMigrationFreePercentage: 100 } })
    ).toBe(false);
  });
  it("per-org override false excludes even at 100%", () => {
    expect(
      isOrgMigrated({ ...base, orgId: "org_x", orgFeatureFlags: { computeMigrationEnabled: false } })
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
        flags: { computeMigrationEnabled: true, computeMigrationFreePercentage: 100, computeMigrationPaidPercentage: 100 },
      })
    ).toBe(false);
  });
  it("undefined planType is not enrolled", () => {
    expect(
      isOrgMigrated({ planType: undefined, orgId: "org_x", orgFeatureFlags: {}, flags: { computeMigrationEnabled: true } })
    ).toBe(false);
  });
});

describe("resolveComputeMigration", () => {
  const enrolled = {
    planType: "free",
    orgFeatureFlags: {},
    flags: { computeMigrationEnabled: true, computeMigrationFreePercentage: 100 },
    envType: "PRODUCTION",
  };
  it("swaps to the compute backing for an enrolled free org", () => {
    expect(resolveComputeMigration({ ...enrolled, baseWorkerQueue: "us-east-1", orgId: "org_x", backing: "us-east-1-next" })).toBe("us-east-1-next");
  });
  it("leaves the queue unchanged when there is no backing for the region (EU)", () => {
    expect(resolveComputeMigration({ ...enrolled, baseWorkerQueue: "eu-central-1", orgId: "org_x", backing: undefined })).toBe("eu-central-1");
  });
  it("does not migrate DEVELOPMENT", () => {
    expect(resolveComputeMigration({ ...enrolled, baseWorkerQueue: "us-east-1", orgId: "org_x", backing: "us-east-1-next", envType: "DEVELOPMENT" })).toBe("us-east-1");
  });
  it("leaves a non-enrolled org untouched", () => {
    expect(resolveComputeMigration({ ...enrolled, baseWorkerQueue: "us-east-1", orgId: "org_x", backing: "us-east-1-next", flags: { computeMigrationEnabled: false } })).toBe("us-east-1");
  });
  it("undefined baseWorkerQueue passes through", () => {
    expect(resolveComputeMigration({ ...enrolled, baseWorkerQueue: undefined, orgId: "org_x", backing: "us-east-1-next" })).toBeUndefined();
  });
});
