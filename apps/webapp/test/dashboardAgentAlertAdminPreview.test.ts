/**
 * A watch can only exist because its owner could use the agent, so the alert gate has to
 * decide access the same way the agent's own gate does. There is no session behind these
 * calls — the delivery job, and the agent's own token-authenticated routes — so the admin
 * preview the agent honours has to be read off the user row.
 */

import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";

const ctx = vi.hoisted(() => ({ admin: false }));

vi.mock("~/db.server", () => {
  const db = {
    user: { findFirst: async () => ({ admin: ctx.admin }) },
    organization: { findFirst: async () => ({ featureFlags: {} }) },
    featureFlag: { findFirst: async () => null },
  };
  return { prisma: db, $replica: db, sqlDatabaseSchema: undefined };
});

vi.stubEnv("SESSION_SECRET", "test-session-secret-for-alert-admin-preview");
// The install this is previewed on: the flag is off for everyone else.
vi.stubEnv("DASHBOARD_AGENT_ADMIN_PREVIEW", "1");
vi.stubEnv("DASHBOARD_AGENT_ENABLED", undefined);

const { canUseDashboardAgentAlerts } = await import("~/services/dashboardAgentWatchAlerts.server");

const params = { userId: "user_1", organizationId: "org_1", organizationSlug: "acme" };

beforeEach(() => {
  ctx.admin = false;
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("watch alerts during the admin preview", () => {
  test("let an admin's watch alert, exactly as the agent lets them create it", async () => {
    ctx.admin = true;
    expect(await canUseDashboardAgentAlerts(params)).toEqual({ allowed: true });
  });

  test("stay shut for everyone the flag is still off for", async () => {
    expect(await canUseDashboardAgentAlerts(params)).toEqual({
      allowed: false,
      reason: "dashboard_agent_disabled",
    });
  });
});
