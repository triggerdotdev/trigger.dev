/**
 * The email gate is the one place the installation's mail config decides whether a watch may
 * subscribe. Both variables are required: with either one missing the channel would be created
 * but never deliver, so the refusal has to come off the env, not off the caller.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {} as { ALERT_FROM_EMAIL?: string; ALERT_EMAIL_TRANSPORT?: string },
  canAccessDashboardAgent: vi.fn(async () => true),
}));

vi.mock("~/env.server", () => ({ env: mocks.env }));
vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: mocks.canAccessDashboardAgent,
}));
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {}, sqlDatabaseSchema: undefined }));
vi.mock("~/v3/alertsWorker.server", () => ({ alertsWorker: { enqueue: vi.fn() } }));
vi.mock("~/v3/services/alerts/createAlertChannel.server", () => ({
  CreateAlertChannelService: class {},
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { canUseDashboardAgentEmailAlerts } from "~/services/dashboardAgentWatchAlerts.server";

const PARAMS = {
  userId: "usr_1",
  organizationId: "org_1",
  organizationSlug: "acme",
  orgFeatureFlags: null,
  projectId: "proj_1",
};

describe("canUseDashboardAgentEmailAlerts", () => {
  beforeEach(() => {
    mocks.env.ALERT_FROM_EMAIL = "alerts@example.com";
    mocks.env.ALERT_EMAIL_TRANSPORT = "smtp";
  });

  test("refuses when only the from address is missing", async () => {
    mocks.env.ALERT_FROM_EMAIL = undefined;

    await expect(canUseDashboardAgentEmailAlerts(PARAMS)).resolves.toEqual({
      allowed: false,
      reason: "email_alerts_not_configured",
    });
  });

  test("refuses when only the transport is missing", async () => {
    mocks.env.ALERT_EMAIL_TRANSPORT = undefined;

    await expect(canUseDashboardAgentEmailAlerts(PARAMS)).resolves.toEqual({
      allowed: false,
      reason: "email_alerts_not_configured",
    });
  });

  test("allows when both are configured and the base gate passes", async () => {
    await expect(canUseDashboardAgentEmailAlerts(PARAMS)).resolves.toEqual({ allowed: true });
  });
});
