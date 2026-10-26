import { beforeEach, describe, expect, it, vi } from "vitest";

const STATE = vi.hoisted(() => ({ alertsEnabledEnv: "1", admin: false }));

vi.mock("~/env.server", () => ({
  env: {
    get ALERTS_ENABLED() {
      return STATE.alertsEnabledEnv;
    },
  },
}));
vi.mock("~/v3/featureFlags.server", () => ({
  makeFlag:
    () =>
    async (opts: { key: string; defaultValue: boolean; overrides: Record<string, unknown> }) =>
      (opts.overrides[opts.key] as boolean | undefined) ?? opts.defaultValue,
}));
vi.mock("~/db.server", () => ({
  prisma: { user: { findFirst: async () => ({ admin: STATE.admin }) } },
  $replica: { user: { findFirst: async () => ({ admin: STATE.admin }) } },
}));

import { canUseMonitoringAlerts } from "~/services/monitoringAlertsApi.server";

const project = (organizationFeatureFlags: Record<string, unknown> | null) => ({
  id: "p",
  externalRef: "proj_p",
  organizationId: "o",
  organizationSlug: "o",
  organizationFeatureFlags,
});

beforeEach(() => {
  STATE.alertsEnabledEnv = "1";
  STATE.admin = false;
});

describe("canUseMonitoringAlerts", () => {
  it("follows ALERTS_ENABLED when the org has no override", async () => {
    expect(await canUseMonitoringAlerts(project(null), "u")).toBe(true);
    expect(await canUseMonitoringAlerts(project({}), "u")).toBe(true);
  });

  it("denies a non-admin when the org override is off", async () => {
    expect(await canUseMonitoringAlerts(project({ alertsEnabled: false }), "u")).toBe(false);
  });

  it("denies a non-admin when ALERTS_ENABLED is unset", async () => {
    STATE.alertsEnabledEnv = "";
    expect(await canUseMonitoringAlerts(project(null), "u")).toBe(false);
  });

  it("allows an admin with the org flag off when alerts are configured", async () => {
    STATE.admin = true;
    expect(await canUseMonitoringAlerts(project({ alertsEnabled: false }), "u")).toBe(true);
  });

  it("denies an admin when alerts are not configured", async () => {
    STATE.alertsEnabledEnv = "";
    STATE.admin = true;
    expect(await canUseMonitoringAlerts(project({ alertsEnabled: false }), "u")).toBe(false);
  });
});
